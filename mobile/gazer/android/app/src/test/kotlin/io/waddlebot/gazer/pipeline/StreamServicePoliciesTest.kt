package io.waddlebot.gazer.pipeline

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkConstructor
import io.mockk.mockkStatic
import io.mockk.unmockkConstructor
import io.mockk.unmockkStatic
import io.mockk.verify
import io.waddlebot.gazer.pigeon.GazerErrorCode
import io.waddlebot.gazer.pigeon.NativePipelineState
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * foregroundServiceType/isStopAction/notification-building are the pure decision points and
 * Android-API-call wrappers StreamService's onCreate/onStartCommand/stopReceiver delegate to -
 * each takes its Android dependency as a plain parameter (SDK int, NotificationManager, Context)
 * instead of reading Build.VERSION.SDK_INT or `this` directly, so they are testable with mockk
 * instead of needing Robolectric/instrumentation.
 */
class StreamServicePoliciesTest {
    @Test
    fun `foregroundServiceType is null below Android Q`() {
        assertNull(foregroundServiceType(Build.VERSION_CODES.P))
    }

    @Test
    fun `foregroundServiceType combines camera and microphone from Android Q onward`() {
        val expected = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        assertEquals(expected, foregroundServiceType(Build.VERSION_CODES.Q))
    }

    @Test
    fun `isStopAction is true only for StreamService's ACTION_STOP`() {
        assertTrue(isStopAction(StreamService.ACTION_STOP))
        assertFalse(isStopAction("some.other.action"))
        assertFalse(isStopAction(null))
    }

    @Test
    fun `buildNotificationChannel constructs without throwing`() {
        // NotificationChannel's own getters (id/name/importance) are stubbed to return default
        // values under the JVM unit-test android.jar (no Robolectric here) regardless of what the
        // constructor was given, so this only asserts construction succeeds - the real values are
        // exercised on a device by the instrumented StreamServiceTest.
        assertNotNull(buildNotificationChannel())
    }

    @Test
    fun `registerNotificationChannel registers the built channel with the manager`() {
        val manager = mockk<NotificationManager>(relaxed = true)

        registerNotificationChannel(manager)

        verify { manager.createNotificationChannel(any()) }
    }

    @Test
    fun `buildStopPendingIntent targets this package with an immutable, update-current broadcast`() {
        // setPackage is load-bearing: StreamService registers its stop receiver with
        // RECEIVER_NOT_EXPORTED (required from API 33), and an implicit broadcast - one carrying
        // neither a package nor a component - is never delivered to a non-exported receiver, so the
        // notification's Stop action would silently do nothing on Android 14+. FLAG_IMMUTABLE is
        // equally load-bearing: Android 12+ rejects a PendingIntent that declares neither
        // mutability flag. Neither is observable through the return value under the stubbed
        // unit-test android.jar (PendingIntent.getBroadcast is a no-op returning null), so the
        // Intent construction and the static call are mocked and asserted directly.
        val context = mockk<Context>(relaxed = true)
        every { context.packageName } returns "io.waddlebot.gazer"
        val expected = mockk<PendingIntent>()
        mockkConstructor(Intent::class)
        mockkStatic(PendingIntent::class)
        try {
            every { anyConstructed<Intent>().setPackage(any()) } answers { self as Intent }
            every { PendingIntent.getBroadcast(any(), any(), any(), any()) } returns expected

            val actual = buildStopPendingIntent(context)

            assertSame(expected, actual)
            verify { anyConstructed<Intent>().setPackage("io.waddlebot.gazer") }
            verify {
                PendingIntent.getBroadcast(
                    context,
                    0,
                    any(),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }
        } finally {
            unmockkStatic(PendingIntent::class)
            unmockkConstructor(Intent::class)
        }
    }

    @Test
    fun `startForegroundOrReportDenied reports nothing when the OS allows the start`() {
        var denials = 0

        val started = startForegroundOrReportDenied(startForeground = { }, reportDenied = { _, _ -> denials++ })

        assertTrue(started)
        assertEquals(0, denials)
    }

    @Test
    fun `an OS refusal of startForeground becomes serviceStartDenied, never a crash`() {
        // Android 12+ throws ForegroundServiceStartNotAllowedException (an IllegalStateException)
        // when a foreground start is not permitted, and Android 14+ throws SecurityException when
        // CAMERA/RECORD_AUDIO is not held at start time - a one-time grant can expire, or the user
        // can revoke it, between Dart's permission gate and this call. Unguarded, either one kills
        // the process.
        listOf(IllegalStateException("not allowed to start foreground service"), SecurityException("requires permissions"))
            .forEach { refusal ->
                val reported = mutableListOf<Pair<GazerErrorCode, String>>()

                // An escaping refusal fails this test on its own - unguarded, it killed the process.
                val started =
                    startForegroundOrReportDenied(
                        startForeground = { throw refusal },
                        reportDenied = { error, detail -> reported.add(error to detail) },
                    )

                assertFalse(started)
                assertEquals(GazerErrorCode.SERVICE_START_DENIED, reported.single().first)
                assertTrue(reported.single().second.contains(refusal::class.java.simpleName))
            }
    }

    @Test
    fun `a non-refusal throwable out of startForeground still propagates`() {
        assertThrows(RuntimeException::class.java) {
            startForegroundOrReportDenied(startForeground = { throw RuntimeException("bug") }, reportDenied = { _, _ -> })
        }
    }

    @Test
    fun `stopEverything stops the pipeline before dropping the notification and the service`() {
        // Ordering is the decision: stopping the pipeline first releases the camera, mic and RTMP
        // socket and lets IDLE reach Dart while the service is still alive to relay it.
        val calls = mutableListOf<String>()
        val controller =
            ServiceTeardownController(
                stopPipeline = { calls.add("pipeline") },
                dropForegroundNotification = { calls.add("notification") },
                stopService = { calls.add("service") },
            )

        controller.stopEverything()

        assertEquals(listOf("pipeline", "notification", "service"), calls)
    }

    @Test
    fun `releaseForegroundOnly never re-enters the pipeline`() {
        // The pipeline has already released its engine by the time it reports ERROR; calling stop()
        // again would emit STOPPING/IDLE over the failure Dart has turned into ReconnectingState.
        val calls = mutableListOf<String>()
        val controller =
            ServiceTeardownController(
                stopPipeline = { calls.add("pipeline") },
                dropForegroundNotification = { calls.add("notification") },
                stopService = { calls.add("service") },
            )

        controller.releaseForegroundOnly()

        assertEquals(listOf("notification", "service"), calls)
    }

    @Test
    fun `a terminal ERROR drops the foreground claim, every other state leaves it alone`() {
        // Without this the service stays foregrounded with a notification still claiming
        // "Gazer is live" after Dart has exhausted its reconnect budget and settled on ErrorState.
        val calls = mutableListOf<String>()
        val controller =
            ServiceTeardownController(
                stopPipeline = { calls.add("pipeline") },
                dropForegroundNotification = { calls.add("notification") },
                stopService = { calls.add("service") },
            )

        NativePipelineState.entries.filter { it != NativePipelineState.ERROR }.forEach { controller.onState(it) }
        assertTrue(calls.isEmpty(), "non-terminal states must not tear the service down: $calls")

        controller.onState(NativePipelineState.ERROR)

        assertEquals(listOf("notification", "service"), calls)
    }
}
