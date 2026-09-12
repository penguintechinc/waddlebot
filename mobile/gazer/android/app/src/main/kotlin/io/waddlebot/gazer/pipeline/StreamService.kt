package io.waddlebot.gazer.pipeline

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import io.waddlebot.gazer.pigeon.GazerErrorCode
import io.waddlebot.gazer.pigeon.NativePipelineState
import io.waddlebot.gazer.pigeon.StatsSample
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Fans PipelineListener calls out to every attached listener, so PigeonHostApiImpl can attach
 * itself after binding without ever replacing StreamService's own wake-lock-controlling
 * listener - GazerPipeline's `listener` constructor field (fixed at construction, per the
 * SHARED CONTRACT) never changes. Backed by [CopyOnWriteArrayList]: StatsSampler's own
 * ScheduledExecutorService thread delivers `onStats` here concurrently with attach/detach calls
 * that can happen on the main thread (PigeonHostApiImpl binding/unbinding), so a plain
 * MutableList would risk a ConcurrentModificationException.
 */
class RelayPipelineListener : PipelineListener {
    private val listeners = CopyOnWriteArrayList<PipelineListener>()

    fun attach(listener: PipelineListener) {
        listeners.add(listener)
    }

    fun detach(listener: PipelineListener) {
        listeners.remove(listener)
    }

    override fun onState(
        state: NativePipelineState,
        error: GazerErrorCode?,
        detail: String?,
    ) {
        listeners.forEach { it.onState(state, error, detail) }
    }

    override fun onStats(sample: StatsSample) {
        listeners.forEach { it.onStats(sample) }
    }

    override fun onAuthResult(ok: Boolean) {
        listeners.forEach { it.onAuthResult(ok) }
    }

    override fun onServiceReleased() {
        listeners.forEach { it.onServiceReleased() }
    }
}

/**
 * Foreground service hosting the live GazerPipeline. Owns the persistent "gazer.stream"
 * notification (with a Stop action broadcasting ACTION_STOP), a partial wake lock held only
 * while streaming, and stops the pipeline on task removal and in onDestroy so a killed/removed app
 * never leaves RootEncoder running against a camera or socket.
 *
 * Every decision this service makes is delegated to an already-unit-tested helper -
 * [WakeLockController], [ServiceTeardownController], [startForegroundOrReportDenied],
 * [foregroundServiceType], [isStopAction], [buildStreamPipeline] - because the Service lifecycle
 * callbacks themselves cannot run on the JVM unit-test target and are JaCoCo-excluded (ruling R29).
 * Anything added here later must be extracted the same way, never left inline.
 */
class StreamService : Service() {
    companion object {
        const val ACTION_STOP = "io.waddlebot.gazer.action.STOP"
        private const val WAKE_LOCK_TAG = "gazer:stream-service"

        /** Starts the service in the foreground; safe to call repeatedly. */
        fun start(context: Context) {
            context.startForegroundService(Intent(context, StreamService::class.java))
        }

        /** Stops the service; safe to call when not running. */
        fun stop(context: Context) {
            context.stopService(Intent(context, StreamService::class.java))
        }
    }

    /**
     * Binder exposing the live pipeline and a way to attach the bound client as a listener.
     * Takes [pipelineProvider]/[attachListener] as constructor parameters rather than being an
     * `inner class` of StreamService, so it can be constructed directly in a plain JVM unit test
     * (PigeonHostApiImplTest) without a real, Robolectric/instrumentation-backed Service instance.
     */
    class LocalBinder(
        private val pipelineProvider: () -> GazerPipeline,
        private val attachListener: (PipelineListener) -> Unit,
    ) : Binder() {
        val pipeline: GazerPipeline get() = pipelineProvider()

        fun setListener(listener: PipelineListener) {
            attachListener(listener)
        }
    }

    private val listenerRelay = RelayPipelineListener()
    private val binder = LocalBinder(pipelineProvider = { pipeline }, attachListener = { listenerRelay.attach(it) })
    private var wakeLock: PowerManager.WakeLock? = null

    private val pipeline: GazerPipeline by lazy { buildStreamPipeline(applicationContext, listenerRelay) }

    private val wakeLockController = WakeLockController(acquire = ::acquireWakeLock, release = ::releaseWakeLock)

    /** Lazy so constructing a StreamService on the JVM unit-test target never touches a Looper. */
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    /** Main-thread [DelayedRunner] backing [ServiceTeardownController]'s idle-release timer. */
    private val delayedRunner =
        DelayedRunner { delayMs, task ->
            val runnable = Runnable { task() }
            mainHandler.postDelayed(runnable, delayMs)
            Cancellation { mainHandler.removeCallbacks(runnable) }
        }

    private val teardownController =
        ServiceTeardownController(
            stopPipeline = { pipeline.stop() },
            dropForegroundNotification = { stopForeground(STOP_FOREGROUND_REMOVE) },
            stopService = { stopSelf() },
            releaseWakeLock = ::releaseWakeLock,
            releaseBoundClients = { listenerRelay.onServiceReleased() },
            delayedRunner = delayedRunner,
            idleReleaseMs = ServiceTeardownController.DEFAULT_IDLE_RELEASE_MS,
        )

    private val stopReceiver =
        object : BroadcastReceiver() {
            override fun onReceive(
                context: Context,
                intent: Intent,
            ) {
                // isStopAction and the teardown ordering are the only decisions here, and both are
                // extracted and unit-tested (StreamServicePoliciesTest); what is left is purely
                // Service-framework-bound plumbing.
                if (isStopAction(intent.action)) teardownController.stopEverything()
            }
        }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val filter = IntentFilter(ACTION_STOP)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(stopReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            // Below API 33 the flag parameter does not exist; the branch above supplies
            // RECEIVER_NOT_EXPORTED wherever the platform accepts it, so lint's warning is moot here.
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(stopReceiver, filter)
        }
        listenerRelay.attach(
            object : PipelineListener {
                override fun onState(
                    state: NativePipelineState,
                    error: GazerErrorCode?,
                    detail: String?,
                ) {
                    wakeLockController.onState(state)
                    teardownController.onState(state)
                }

                override fun onStats(sample: StatsSample) = Unit

                override fun onAuthResult(ok: Boolean) = Unit
            },
        )
    }

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        val notification = buildNotification()
        val serviceType = foregroundServiceType(Build.VERSION.SDK_INT)
        val started =
            startForegroundOrReportDenied(
                startForeground = {
                    if (serviceType != null) {
                        startForeground(NOTIFICATION_ID, notification, serviceType)
                    } else {
                        startForeground(NOTIFICATION_ID, notification)
                    }
                },
                reportDenied = { error, detail -> listenerRelay.onState(NativePipelineState.ERROR, error, detail) },
            )
        // One teardown, not two, and never through the pipeline: reportDenied above already
        // relayed the ERROR (which arms the idle-release timer), and stopEverything() here would
        // both repeat the foreground teardown and touch the `by lazy` pipeline - constructing it,
        // camera service and all, purely to stop it - emitting STOPPING/IDLE over the ERROR that
        // should be the last thing Dart hears.
        if (!started) teardownController.releaseForegroundOnly()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    /**
     * Swiping the app away removes the task but not a started foreground service, so without this
     * the stream would keep running against the camera, mic and RTMP socket with MainActivity and
     * the Flutter engine already gone - reachable only through the notification's Stop action. The
     * spec's Foreground Service section requires "App killed: stream stops cleanly".
     *
     * The manifest must NOT declare `android:stopWithTask="true"` alongside this: per the
     * `Service.onTaskRemoved` contract, setting FLAG_STOP_WITH_TASK means this callback is not
     * delivered and the service is simply stopped - which would skip the ordered teardown below
     * (pipeline first, so camera/mic/socket are released and IDLE reaches Dart while the service
     * is still alive) and leave the only tested swipe-away path dead. ManifestContentTest asserts
     * the attribute's absence.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        teardownController.stopEverything()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        teardownController.cancelIdleRelease()
        pipeline.dispose()
        releaseWakeLock()
        runCatching { unregisterReceiver(stopReceiver) }
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        registerNotificationChannel(getSystemService(NotificationManager::class.java))
    }

    private fun buildNotification(): Notification {
        val stopIntent = buildStopPendingIntent(this)
        return NotificationCompat
            .Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle(NOTIFICATION_TITLE)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setOngoing(true)
            .addAction(0, NOTIFICATION_STOP_ACTION_LABEL, stopIntent)
            .build()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock =
            powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
                setReferenceCounted(false)
                acquire(TimeUnit.HOURS.toMillis(4))
            }
    }

    /**
     * Test seam - `internal` (not `private`) so StreamServiceUnitTest can exercise the
     * no-wake-lock-yet no-op path without a real Context.
     */
    internal fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }
}
