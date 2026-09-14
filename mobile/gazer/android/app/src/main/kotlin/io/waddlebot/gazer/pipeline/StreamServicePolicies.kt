package io.waddlebot.gazer.pipeline

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.camera2.CameraManager
import android.os.Build
import io.waddlebot.gazer.pigeon.GazerErrorCode
import io.waddlebot.gazer.pigeon.NativePipelineState
import io.waddlebot.gazer.pipeline.sources.AudioSourceFactory
import io.waddlebot.gazer.pipeline.sources.CameraManagerIds
import io.waddlebot.gazer.pipeline.sources.VideoSourceFactory

/** StreamService's persistent notification channel id, also its Android notification-tap-target identity. */
internal const val NOTIFICATION_CHANNEL_ID = "gazer.stream"
internal const val NOTIFICATION_CHANNEL_NAME = "Gazer streaming"
internal const val NOTIFICATION_ID = 1001
internal const val NOTIFICATION_TITLE = "Gazer is live"
internal const val NOTIFICATION_STOP_ACTION_LABEL = "Stop"

/**
 * Decides whether a native state transition should acquire or release StreamService's partial
 * wake lock, driving injected [acquire]/[release] actions instead of a real PowerManager. Pure
 * decision table extracted out of StreamService's Service-framework-bound PipelineListener so it
 * can be unit-tested without Robolectric/instrumentation.
 */
class WakeLockController(
    private val acquire: () -> Unit,
    private val release: () -> Unit,
) {
    /**
     * Applies the wake-lock decision for [state]: acquire while streaming, release once the
     * session is deliberately over (IDLE, STOPPING), no-op otherwise.
     *
     * ERROR deliberately does **not** release. Kotlin cannot tell a transient ERROR - the first
     * blip of a Dart-driven reconnect, which sleeps through a backoff and then re-prepares - from
     * a terminal one, and releasing here let the device sleep through that backoff and stall the
     * retry. The "held forever after a terminal failure" half of that problem is handled by
     * [ServiceTeardownController]'s bounded idle-release timer instead, which releases the wake
     * lock along with the rest only once nothing has happened for
     * [ServiceTeardownController.DEFAULT_IDLE_RELEASE_MS].
     */
    fun onState(state: NativePipelineState) {
        when (state) {
            NativePipelineState.STREAMING -> acquire()
            NativePipelineState.IDLE, NativePipelineState.STOPPING -> release()
            else -> Unit
        }
    }
}

/** Cancels a one-shot task scheduled through [DelayedRunner]. */
fun interface Cancellation {
    fun cancel()
}

/**
 * Schedules one-shot delayed work. Indirected behind an interface so
 * [ServiceTeardownController]'s idle-release timer is unit-testable on the JVM, with no Looper
 * and no real waiting; StreamService supplies a main-thread Handler implementation.
 */
fun interface DelayedRunner {
    /** Runs [task] after [delayMs]; the returned [Cancellation] un-schedules it if it has not run. */
    fun runAfter(
        delayMs: Long,
        task: () -> Unit,
    ): Cancellation
}

/**
 * Owns StreamService's teardown sequences and its idle-release timer, with each
 * Service-framework action injected as a lambda so the ordering and the timing - the only real
 * decisions here - are unit-testable without Robolectric/instrumentation.
 *
 * The foreground service, its notification and the wake lock are deliberately **kept** across an
 * ERROR. Dart owns the reconnect decision, and its `_retryAfter` re-prepares on the same bound
 * host without ever calling `stop()`, so `PigeonHostApiImpl.prepare` short-circuits on a non-null
 * `host` and `StreamService.start()` is never called again - dropping the foreground claim on the
 * first blip would lose it, and the camera|microphone service type with it, for the rest of the
 * session (and on Android 12+ a background re-start would be refused anyway). Instead an ERROR
 * arms a bounded timer: if a prepare/start follows within [idleReleaseMs] the timer is cancelled
 * and nothing was lost; if nothing follows, the session really is over and everything is released -
 * including the binding itself, so the next prepare() rebuilds the foreground service from scratch
 * rather than reusing a stopped one (see [onIdleReleaseExpired]).
 *
 * Thread safety: [onState] arrives on RootEncoder's callback thread while [stopEverything] can
 * arrive on the main thread, so the pending-timer field is guarded by a monitor held only across
 * the runner's own non-blocking schedule/cancel calls, never across a teardown action.
 */
class ServiceTeardownController(
    private val stopPipeline: () -> Unit,
    private val dropForegroundNotification: () -> Unit,
    private val stopService: () -> Unit,
    private val releaseWakeLock: () -> Unit,
    private val releaseBoundClients: () -> Unit,
    private val delayedRunner: DelayedRunner,
    private val idleReleaseMs: Long,
) {
    companion object {
        /**
         * How long a failed session keeps its foreground service before it is torn down anyway.
         * Must exceed Dart's worst-case gap between an ERROR and the next prepare: the reconnect
         * policy's 30 s maximum backoff times its 1.2 jitter ceiling (36 s) plus the prepare
         * itself. 60 s leaves headroom without leaving a dead notification up for long.
         */
        const val DEFAULT_IDLE_RELEASE_MS = 60_000L
    }

    private val lock = Any()
    private var pendingRelease: Cancellation? = null

    /**
     * Identifies the currently-armed timer. `removeCallbacks` cannot stop a runnable the looper
     * has already dequeued, so an expiring task compares this token before acting: without it a
     * reconnect's PREPARING arriving during dispatch would lose the foreground service anyway, and
     * an ERROR re-arming during dispatch would have its fresh timer cancelled by the expiring one.
     */
    private var pendingToken: Any? = null

    /**
     * Full stop, for the notification's Stop action and for task removal (app swiped away): cancel
     * any pending idle release, then stop the pipeline first so the camera, mic and RTMP socket are
     * released and IDLE reaches Dart while the service is still alive, then drop the notification
     * and the service itself, and finally release the bound clients.
     *
     * The last step closes the same hole [onIdleReleaseExpired] closes for the idle-release timer:
     * [stopService] is `stopSelf()`, and a client holding the service with `BIND_AUTO_CREATE` keeps
     * it alive through that without ever seeing `onServiceDisconnected` - so PigeonHostApiImpl's
     * `host` would stay non-null, its `prepare()` would keep short-circuiting past `bindService()`,
     * and a later manual Go Live from Dart's IdleState would stream from a service that is no
     * longer in the foreground. Safe here for the same reason it is safe on the expiry path:
     * [stopPipeline] has already relayed STOPPING/IDLE and those listener posts run on `mainScope`,
     * which the unbind does not cancel. [releaseBoundClients] is itself idempotent (a no-op when
     * nothing is bound), so this stays safe even if an idle-release timer somehow also fires.
     */
    fun stopEverything() {
        cancelIdleRelease()
        stopPipeline()
        dropForegroundNotification()
        stopService()
        releaseBoundClients()
    }

    /**
     * Drops the foreground claim and the wake lock without touching the pipeline, for when the OS
     * refuses `startForeground`: there is nothing streaming to stop, and re-entering the pipeline
     * would emit STOPPING/IDLE over the ERROR just reported as well as lazily constructing a
     * pipeline purely to stop it. The bound clients are deliberately left alone here - unlike
     * [onIdleReleaseExpired] - because the `prepare()` that triggered this start is still in
     * flight and owns the binding; it learns of the failure from the ERROR it just relayed.
     */
    fun releaseForegroundOnly() {
        cancelIdleRelease()
        dropForeground()
    }

    /** Un-schedules a pending idle release, if any. Safe to call repeatedly; call from onDestroy. */
    fun cancelIdleRelease() {
        val pending =
            synchronized(lock) {
                pendingToken = null
                pendingRelease.also { pendingRelease = null }
            }
        pending?.cancel()
    }

    /** The foreground teardown itself, shared by [releaseForegroundOnly] and the timer expiry. */
    private fun dropForeground() {
        dropForegroundNotification()
        stopService()
        releaseWakeLock()
    }

    /**
     * PipelineListener hook: an ERROR arms the idle-release timer, and any other state - PREPARING
     * from a reconnect's re-prepare, CONNECTING, STREAMING, or the IDLE/STOPPING of a deliberate
     * stop - means the session is alive again (or already being torn down elsewhere) and cancels it.
     */
    fun onState(state: NativePipelineState) {
        if (state == NativePipelineState.ERROR) armIdleRelease() else cancelIdleRelease()
    }

    /** (Re-)arms the idle-release timer, cancelling and replacing any predecessor. */
    private fun armIdleRelease() {
        val previous: Cancellation?
        val token = Any()
        synchronized(lock) {
            previous = pendingRelease
            pendingToken = token
            pendingRelease = delayedRunner.runAfter(idleReleaseMs) { onIdleReleaseExpired(token) }
        }
        previous?.cancel()
    }

    /**
     * The window closed with nothing after the ERROR, so the session really is over: drop the
     * foreground claim, and tell whoever is still bound to let go.
     *
     * Releasing the bound clients is what actually finishes the job. `stopService()` is
     * `stopSelf()`, and a client holding the service with `BIND_AUTO_CREATE` keeps it alive
     * through that without ever seeing `onServiceDisconnected` - so PigeonHostApiImpl's `host`
     * would stay non-null, its `prepare()` would keep short-circuiting past `bindService()`, and a
     * later manual Go Live from Dart's ErrorState would stream from a service that is no longer in
     * the foreground: no notification, no camera|microphone type, camera and mic cut the moment the
     * app is backgrounded. Dropping the binding forces the next `prepare()` back through the full
     * bind + `StreamService.start()` path - which is a user-initiated foreground start, and so
     * allowed on Android 12+.
     *
     * [token] guards the dispatch race: see [pendingToken].
     */
    private fun onIdleReleaseExpired(token: Any) {
        val stillPending =
            synchronized(lock) {
                (pendingToken === token).also {
                    if (it) {
                        pendingToken = null
                        pendingRelease = null
                    }
                }
            }
        if (!stillPending) return
        dropForeground()
        releaseBoundClients()
    }
}

/**
 * Runs [startForeground], mapping an OS refusal to a [GazerErrorCode.SERVICE_START_DENIED] report
 * through [reportDenied] instead of letting it kill the process; returns whether the service is
 * actually in the foreground now.
 *
 * Android 12+ throws `ForegroundServiceStartNotAllowedException` (an `IllegalStateException`) when
 * the app is not allowed to start a foreground service, and Android 14+ throws `SecurityException`
 * when CAMERA/RECORD_AUDIO is not held at start time - a one-time grant can expire, or the user can
 * revoke it, between Dart's permission gate and this call. Only those two families are caught: any
 * other throwable is a genuine programming error and still propagates.
 */
internal fun startForegroundOrReportDenied(
    startForeground: () -> Unit,
    reportDenied: (GazerErrorCode, String) -> Unit,
): Boolean {
    val refusal = runCatching { startForeground() }.exceptionOrNull() ?: return true
    if (!isForegroundStartRefusal(refusal)) throw refusal
    reportDenied(GazerErrorCode.SERVICE_START_DENIED, "startForeground refused: ${refusal::class.java.simpleName}")
    return false
}

/**
 * True when [throwable] is the OS refusing a foreground-service start rather than a bug of ours.
 *
 * Android 12+ throws `ForegroundServiceStartNotAllowedException` (an `IllegalStateException`) when
 * a foreground start is not permitted, and Android 14+ throws `SecurityException` when
 * CAMERA/RECORD_AUDIO is not held at start time. Shared by the two sides of the same call:
 * [startForegroundOrReportDenied] for `Service.startForeground`, and PigeonHostApiImpl's
 * `bindService()` for `Context.startForegroundService`, so both classify a refusal identically and
 * both still let a genuine programming error through.
 */
internal fun isForegroundStartRefusal(throwable: Throwable): Boolean = throwable is IllegalStateException || throwable is SecurityException

/**
 * Resolves the FOREGROUND_SERVICE_TYPE flags StreamService must declare to startForeground() on
 * [sdkInt]: the type parameter is required (and only accepted) from Android 10 (Q) onward, so
 * this returns null below that to signal the two-argument startForeground() overload instead.
 */
internal fun foregroundServiceType(sdkInt: Int): Int? =
    if (sdkInt >= Build.VERSION_CODES.Q) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    } else {
        null
    }

/** True when [action] (a received broadcast's Intent.action) is StreamService's Stop request. */
internal fun isStopAction(action: String?): Boolean = action == StreamService.ACTION_STOP

/** Builds the (silent, low-importance) notification channel StreamService's foreground notification posts to. */
internal fun buildNotificationChannel(): NotificationChannel =
    NotificationChannel(NOTIFICATION_CHANNEL_ID, NOTIFICATION_CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW)

/**
 * Registers [buildNotificationChannel] with [manager] - createNotificationChannel is
 * idempotent, so safe to call on every onCreate.
 */
internal fun registerNotificationChannel(manager: NotificationManager) {
    manager.createNotificationChannel(buildNotificationChannel())
}

/**
 * Builds the PendingIntent StreamService's Stop notification action broadcasts ACTION_STOP through
 * when tapped.
 *
 * setPackage is load-bearing, not tidiness: StreamService registers its stop receiver with
 * RECEIVER_NOT_EXPORTED (required from API 33), and an implicit broadcast - one carrying neither a
 * package nor a component - is not delivered to a non-exported receiver. Without it the Stop action
 * on the ongoing notification silently does nothing on Android 14+, leaving the stream running with
 * no way to end it from the notification shade. Proven by StreamServiceTest, which broadcasts the
 * same way.
 */
internal fun buildStopPendingIntent(context: Context): PendingIntent? =
    PendingIntent.getBroadcast(
        context,
        0,
        Intent(StreamService.ACTION_STOP).setPackage(context.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

/**
 * Builds the GazerPipeline StreamService binds out - the RootEncoder engine factory, video/audio
 * source factories, and the StatsSampler's live-engine lookup - from [context] and [listenerRelay]
 * alone (no StreamService instance needed), so this wiring is unit-testable with a mocked Context
 * the same way GazerFlutterBindings.install is.
 */
internal fun buildStreamPipeline(
    context: Context,
    listenerRelay: RelayPipelineListener,
): GazerPipeline {
    var activeEngine: StreamEngine? = null
    val statsSampler = StatsSampler(engine = { activeEngine }) { sample -> listenerRelay.onStats(sample) }
    val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    return GazerPipeline(
        engineFactory = { checker, video, audio ->
            RootEncoderEngine(context, checker, video, audio).also { activeEngine = it }
        },
        videoSources = VideoSourceFactory(context, CameraManagerIds(cameraManager)),
        audioSources = AudioSourceFactory(),
        listener = listenerRelay,
        statsSampler = statsSampler,
    )
}
