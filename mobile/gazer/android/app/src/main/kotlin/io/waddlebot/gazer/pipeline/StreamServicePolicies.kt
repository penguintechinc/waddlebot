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
     * Applies the wake-lock decision for [state]: acquire while streaming, release on every state
     * that means the stream is over - IDLE, STOPPING and ERROR alike - and no-op otherwise.
     *
     * ERROR is load-bearing, not symmetry: when Dart exhausts its reconnect budget it settles on
     * ErrorState without driving the pipeline back to IDLE, so releasing only on IDLE leaves the
     * PARTIAL_WAKE_LOCK held until its 4-hour timeout with nothing streaming behind it.
     */
    fun onState(state: NativePipelineState) {
        when (state) {
            NativePipelineState.STREAMING -> acquire()
            NativePipelineState.IDLE, NativePipelineState.STOPPING, NativePipelineState.ERROR -> release()
            else -> Unit
        }
    }
}

/**
 * Owns StreamService's two teardown sequences, with each Service-framework action injected as a
 * lambda so the ordering - which is the only real decision here - is unit-testable without
 * Robolectric/instrumentation.
 */
class ServiceTeardownController(
    private val stopPipeline: () -> Unit,
    private val dropForegroundNotification: () -> Unit,
    private val stopService: () -> Unit,
) {
    /**
     * Full stop, for the notification's Stop action and for task removal (app swiped away): stop
     * the pipeline first so the camera, mic and RTMP socket are released and IDLE reaches Dart
     * while the service is still alive, then drop the notification and the service itself.
     */
    fun stopEverything() {
        stopPipeline()
        dropForegroundNotification()
        stopService()
    }

    /**
     * Terminal-failure teardown. The pipeline has already released its engine by the time it
     * reports ERROR, so nothing here touches it - re-entering stop() would emit STOPPING/IDLE over
     * the failure Dart has already turned into ReconnectingState. Only the foreground claim goes:
     * the "Gazer is live" notification stops lying, and the started-state is dropped. A bound
     * client (PigeonHostApiImpl holds BIND_AUTO_CREATE until its own stop()) keeps the service and
     * its pipeline alive, so a Dart-driven reconnect can re-prepare and re-foreground normally.
     */
    fun releaseForegroundOnly() {
        dropForegroundNotification()
        stopService()
    }

    /** PipelineListener hook: ERROR is terminal for the foreground claim, every other state is not. */
    fun onState(state: NativePipelineState) {
        if (state == NativePipelineState.ERROR) releaseForegroundOnly()
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
): Boolean =
    try {
        startForeground()
        true
    } catch (e: IllegalStateException) {
        reportDenied(GazerErrorCode.SERVICE_START_DENIED, "startForeground refused: ${e::class.java.simpleName}")
        false
    } catch (e: SecurityException) {
        reportDenied(GazerErrorCode.SERVICE_START_DENIED, "startForeground refused: ${e::class.java.simpleName}")
        false
    }

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
