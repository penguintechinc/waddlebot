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

/** One task handed to [FakeDelayedRunner], firable and cancellable by hand from a test. */
private class ScheduledTask(
    val delayMs: Long,
    private val task: () -> Unit,
) : Cancellation {
    var cancelled = false
        private set

    override fun cancel() {
        cancelled = true
    }

    /** Runs the task as the real runner would once [delayMs] elapsed - unless it was cancelled. */
    fun fire() {
        if (!cancelled) task()
    }

    /**
     * Runs the task even though it was cancelled, as `Handler.removeCallbacks` cannot prevent for
     * a runnable the looper has already dequeued.
     */
    fun fireEvenIfCancelled() = task()
}

/**
 * [DelayedRunner] that records what was scheduled instead of posting it, so the idle-release
 * timer's arm/cancel/expire behaviour is asserted deterministically with no Looper and no waiting.
 */
private class FakeDelayedRunner : DelayedRunner {
    val scheduled = mutableListOf<ScheduledTask>()

    override fun runAfter(
        delayMs: Long,
        task: () -> Unit,
    ): Cancellation = ScheduledTask(delayMs, task).also { scheduled.add(it) }
}

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

    /**
     * Builds a controller over [calls] with a [FakeDelayedRunner], so every test below shares one
     * call vocabulary ("pipeline", "notification", "service", "wakelock") and can drive the
     * idle-release timer by hand instead of waiting on a real clock.
     */
    private fun teardownController(
        calls: MutableList<String>,
        runner: FakeDelayedRunner,
        idleReleaseMs: Long = 60_000L,
    ) = ServiceTeardownController(
        stopPipeline = { calls.add("pipeline") },
        dropForegroundNotification = { calls.add("notification") },
        stopService = { calls.add("service") },
        releaseWakeLock = { calls.add("wakelock") },
        releaseBoundClients = { calls.add("clients") },
        delayedRunner = runner,
        idleReleaseMs = idleReleaseMs,
    )

    @Test
    fun `stopEverything stops the pipeline before dropping the notification, the service and the bound clients`() {
        // Ordering is the decision: stopping the pipeline first releases the camera, mic and RTMP
        // socket and lets IDLE reach Dart while the service is still alive to relay it. The bound
        // clients are released last (R1, the same hole NB1 closed for the idle-release timer):
        // stopService() is stopSelf(), and a BIND_AUTO_CREATE client keeps the service alive through
        // that without ever seeing onServiceDisconnected - so without this, tapping Stop in the
        // shade and then Go Live again would short-circuit past bindService()/StreamService.start()
        // and stream with no foreground claim.
        val calls = mutableListOf<String>()
        val controller = teardownController(calls, FakeDelayedRunner())

        controller.stopEverything()

        assertEquals(listOf("pipeline", "notification", "service", "clients"), calls)
    }

    @Test
    fun `releaseForegroundOnly never re-enters the pipeline`() {
        // Used when the OS refuses startForeground (nothing is streaming, and re-entering the
        // pipeline would emit STOPPING/IDLE over the ERROR just reported - as well as lazily
        // constructing a pipeline purely to stop it) and when the idle-release timer expires.
        val calls = mutableListOf<String>()
        val controller = teardownController(calls, FakeDelayedRunner())

        controller.releaseForegroundOnly()

        assertEquals(listOf("notification", "service", "wakelock"), calls)
    }

    @Test
    fun `an ERROR arms the idle-release timer rather than tearing the service down at once`() {
        // N1: dropping the foreground claim on every ERROR permanently de-foregrounded any session
        // that reconnected - Dart's _retryAfter re-prepares on the same bound host and never calls
        // stop(), so PigeonHostApiImpl.prepare short-circuits on a non-null host and
        // StreamService.start() - and therefore startForeground - never runs again.
        val calls = mutableListOf<String>()
        val runner = FakeDelayedRunner()
        val controller = teardownController(calls, runner)

        controller.onState(NativePipelineState.ERROR)

        assertTrue(calls.isEmpty(), "ERROR must keep the FGS, the notification and the wake lock: $calls")
        assertEquals(1, runner.scheduled.size, "ERROR must arm exactly one idle-release timer")
        assertEquals(60_000L, runner.scheduled.single().delayMs)
    }

    @Test
    fun `an ERROR followed by a reconnect's prepare inside the window keeps the foreground service`() {
        val calls = mutableListOf<String>()
        val runner = FakeDelayedRunner()
        val controller = teardownController(calls, runner)
        controller.onState(NativePipelineState.ERROR)
        val armed = runner.scheduled.single()

        controller.onState(NativePipelineState.PREPARING)

        assertTrue(armed.cancelled, "a re-prepare must cancel the pending idle release")
        armed.fire()
        assertTrue(calls.isEmpty(), "a cancelled timer must not tear anything down: $calls")
    }

    @Test
    fun `every state other than ERROR cancels a pending idle release`() {
        NativePipelineState.entries.filter { it != NativePipelineState.ERROR }.forEach { state ->
            val calls = mutableListOf<String>()
            val runner = FakeDelayedRunner()
            val controller = teardownController(calls, runner)
            controller.onState(NativePipelineState.ERROR)

            controller.onState(state)

            assertTrue(runner.scheduled.single().cancelled, "$state must cancel the pending idle release")
            assertTrue(calls.isEmpty(), "$state must not tear anything down: $calls")
        }
    }

    @Test
    fun `an ERROR with nothing after it releases the foreground service once the window expires`() {
        val calls = mutableListOf<String>()
        val runner = FakeDelayedRunner()
        val controller = teardownController(calls, runner)
        controller.onState(NativePipelineState.ERROR)

        runner.scheduled.single().fire()

        // The engine was already released when the ERROR was reported, so the pipeline is not
        // re-entered. The bound clients are released last (NB1): stopSelf() on a service a
        // BIND_AUTO_CREATE client still holds does not destroy it and never fires
        // onServiceDisconnected, so without this the client keeps a handle on a service that is no
        // longer in the foreground and its next prepare() skips StreamService.start() entirely.
        assertEquals(listOf("notification", "service", "wakelock", "clients"), calls)
    }

    @Test
    fun `a timer that expires after being superseded does nothing`() {
        // removeCallbacks cannot stop a runnable the looper has already dequeued, so an expiring
        // task must re-check that it is still the pending one: otherwise a reconnect's PREPARING
        // arriving during dispatch loses the foreground service anyway, and an ERROR re-arming
        // during dispatch has its fresh timer cancelled by the expiring one.
        val calls = mutableListOf<String>()
        val runner = FakeDelayedRunner()
        val controller = teardownController(calls, runner)
        controller.onState(NativePipelineState.ERROR)
        val dequeued = runner.scheduled.single()
        controller.onState(NativePipelineState.ERROR)

        dequeued.fireEvenIfCancelled()

        assertTrue(calls.isEmpty(), "a superseded timer must not tear anything down: $calls")
        assertFalse(runner.scheduled[1].cancelled, "the current timer must survive its predecessor's late dispatch")
    }

    @Test
    fun `a stop during the idle window releases immediately and cancels the timer`() {
        val calls = mutableListOf<String>()
        val runner = FakeDelayedRunner()
        val controller = teardownController(calls, runner)
        controller.onState(NativePipelineState.ERROR)
        val armed = runner.scheduled.single()

        controller.stopEverything()

        assertEquals(listOf("pipeline", "notification", "service", "clients"), calls)
        assertTrue(armed.cancelled, "stopEverything must cancel the pending idle release")
        armed.fire()
        assertEquals(
            listOf("pipeline", "notification", "service", "clients"),
            calls,
            "a cancelled timer must not fire a second teardown",
        )
    }

    @Test
    fun `a second ERROR replaces the pending idle release rather than stacking timers`() {
        val calls = mutableListOf<String>()
        val runner = FakeDelayedRunner()
        val controller = teardownController(calls, runner)

        controller.onState(NativePipelineState.ERROR)
        controller.onState(NativePipelineState.ERROR)

        assertEquals(2, runner.scheduled.size)
        assertTrue(runner.scheduled[0].cancelled, "the first timer must be cancelled when a second ERROR re-arms")
        assertFalse(runner.scheduled[1].cancelled)
    }

    @Test
    fun `cancelIdleRelease is safe with nothing pending and clears what is pending`() {
        val calls = mutableListOf<String>()
        val runner = FakeDelayedRunner()
        val controller = teardownController(calls, runner)

        controller.cancelIdleRelease()
        assertTrue(runner.scheduled.isEmpty())

        controller.onState(NativePipelineState.ERROR)
        controller.cancelIdleRelease()

        assertTrue(runner.scheduled.single().cancelled)
        assertTrue(calls.isEmpty())
    }

    @Test
    fun `the idle-release window outlasts Dart's worst-case reconnect gap`() {
        // 30 s maximum backoff x the 1.2 jitter ceiling = 36 s, plus the prepare that follows it.
        assertEquals(60_000L, ServiceTeardownController.DEFAULT_IDLE_RELEASE_MS)
        assertTrue(ServiceTeardownController.DEFAULT_IDLE_RELEASE_MS >= 36_000L)
    }
}
