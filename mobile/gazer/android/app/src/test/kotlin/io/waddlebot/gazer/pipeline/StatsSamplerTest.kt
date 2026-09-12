package io.waddlebot.gazer.pipeline

import io.mockk.every
import io.mockk.mockk
import io.waddlebot.gazer.pigeon.StatsSample
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** One [TickerHandle] handed out by [FakeTicker], remembering whether it was ever cancelled. */
private class FakeHandle : TickerHandle {
    /** Atomic because the start/stop threads write it while the test thread reads it. */
    private val cancelledFlag = AtomicBoolean(false)
    val cancelled: Boolean get() = cancelledFlag.get()

    override fun cancel() {
        cancelledFlag.set(true)
    }
}

private class FakeTicker : Ticker {
    var scheduledTask: (() -> Unit)? = null
    var closed = false
    val handles = CopyOnWriteArrayList<FakeHandle>()

    /** True once any handle this ticker ever issued has been cancelled. */
    val cancelled: Boolean get() = handles.any { it.cancelled }

    /** Latched inside [schedule] so a test can park a start() mid-flight and race a stop() with it. */
    var scheduleGate: CountDownLatch? = null

    /** Counted down on every [schedule] entry; reassign it to wait for a specific one. */
    var scheduleEntered = CountDownLatch(1)

    override fun schedule(
        periodMs: Long,
        task: () -> Unit,
    ): TickerHandle {
        scheduleEntered.countDown()
        scheduleGate?.await(5, TimeUnit.SECONDS)
        scheduledTask = task
        return FakeHandle().also { handles.add(it) }
    }

    override fun close() {
        closed = true
    }

    fun fireTick() = scheduledTask?.invoke()
}

class StatsSamplerTest {
    @Test
    fun `computes fps from the sentVideoFrames delta between ticks`() {
        val engine = mockk<StreamEngine>(relaxed = true)
        every { engine.sentVideoFrames() } returnsMany listOf(30L, 60L)
        every { engine.droppedVideoFrames() } returns 0L
        every { engine.hasCongestion(20f) } returns false
        val ticker = FakeTicker()
        val samples = mutableListOf<StatsSample>()
        val sampler = StatsSampler(engine = { engine }, ticker = ticker, intervalMs = 1000) { samples.add(it) }

        sampler.start()
        ticker.fireTick()
        ticker.fireTick()

        assertEquals(2, samples.size)
        assertEquals(30.0, samples[0].fps)
        assertEquals(30.0, samples[1].fps)
    }

    @Test
    fun `reports dropped frames from the engine`() {
        val engine = mockk<StreamEngine>(relaxed = true)
        every { engine.sentVideoFrames() } returns 0L
        every { engine.droppedVideoFrames() } returns 7L
        every { engine.hasCongestion(20f) } returns false
        val ticker = FakeTicker()
        val samples = mutableListOf<StatsSample>()
        val sampler = StatsSampler(engine = { engine }, ticker = ticker) { samples.add(it) }

        sampler.start()
        ticker.fireTick()

        assertEquals(7L, samples.single().droppedVideoFrames)
    }

    @Test
    fun `bitrateKbps reflects the latest onBitrate value in kbps`() {
        val engine = mockk<StreamEngine>(relaxed = true)
        every { engine.sentVideoFrames() } returns 0L
        every { engine.droppedVideoFrames() } returns 0L
        every { engine.hasCongestion(20f) } returns false
        val ticker = FakeTicker()
        val samples = mutableListOf<StatsSample>()
        val sampler = StatsSampler(engine = { engine }, ticker = ticker) { samples.add(it) }
        sampler.start()

        sampler.onBitrate(2_048_000L)
        ticker.fireTick()

        assertEquals(2048L, samples.single().bitrateKbps)
    }

    @Test
    fun `congestionPercent is 100 when the engine reports congestion else 0`() {
        val engine = mockk<StreamEngine>(relaxed = true)
        every { engine.sentVideoFrames() } returns 0L
        every { engine.droppedVideoFrames() } returns 0L
        every { engine.hasCongestion(20f) } returns true
        val ticker = FakeTicker()
        val samples = mutableListOf<StatsSample>()
        val sampler = StatsSampler(engine = { engine }, ticker = ticker) { samples.add(it) }
        sampler.start()

        ticker.fireTick()

        assertEquals(100.0, samples.single().congestionPercent)
    }

    @Test
    fun `stop cancels the ticker`() {
        val ticker = FakeTicker()
        val sampler = StatsSampler(engine = { null }, ticker = ticker) { }
        sampler.start()

        sampler.stop()

        assertEquals(true, ticker.cancelled)
    }

    @Test
    fun `tick is a no-op when the engine is not yet available`() {
        val ticker = FakeTicker()
        val samples = mutableListOf<StatsSample>()
        val sampler = StatsSampler(engine = { null }, ticker = ticker) { samples.add(it) }
        sampler.start()

        ticker.fireTick()

        assertEquals(0, samples.size)
    }

    @Test
    fun `shutdown cancels the ticker and releases its executor`() {
        val ticker = FakeTicker()
        val sampler = StatsSampler(engine = { null }, ticker = ticker) { }
        sampler.start()

        sampler.shutdown()

        assertTrue(ticker.cancelled, "shutdown must cancel the in-flight tick")
        assertTrue(ticker.closed, "shutdown must close the ticker - otherwise one executor thread leaks per session")
    }

    @Test
    fun `a stop that begins during an in-flight start still cancels the ticker it installs`() {
        // start() and stop() run on different threads in production: start() from the Pigeon caller
        // thread (GazerPipeline.start), stop() from RootEncoder's callback thread
        // (onConnectionFailed/onDisconnect/onAuthError). Unguarded, a stop() landing while start()
        // is still inside ticker.schedule() cancels only the *previous* handle and is then
        // overwritten by start()'s own assignment - the ticker start() installs is never cancelled
        // and keeps sampling a released engine forever.
        //
        // Determinism: start() is parked inside schedule() on a gate, and the gate is released only
        // after stop() has demonstrably run to completion (unguarded) or demonstrably blocked on
        // the monitor (guarded), so the interleaving under test is the one that actually happened.
        val ticker = FakeTicker()
        val sampler = StatsSampler(engine = { null }, ticker = ticker) { }
        sampler.start()
        val firstHandle = ticker.handles.single()

        val gate = CountDownLatch(1)
        ticker.scheduleGate = gate
        ticker.scheduleEntered = CountDownLatch(1)
        val startThread = Thread { sampler.start() }
        startThread.start()
        assertTrue(ticker.scheduleEntered.await(5, TimeUnit.SECONDS), "the second start() never reached ticker.schedule()")
        assertTrue(firstHandle.cancelled, "start() must cancel the handle it replaces")

        val stopEntered = CountDownLatch(1)
        val stopCompleted = CountDownLatch(1)
        val stopThread =
            Thread {
                stopEntered.countDown()
                sampler.stop()
                stopCompleted.countDown()
            }
        stopThread.start()
        assertTrue(stopEntered.await(5, TimeUnit.SECONDS), "the stop thread never started")
        // Unguarded, stop() returns immediately here (it finds only the already-cancelled first
        // handle); guarded, it blocks on the monitor until the gate below lets start() finish.
        val stopFinishedBeforeStart = stopCompleted.await(2, TimeUnit.SECONDS)
        gate.countDown()
        startThread.join(5_000)
        stopThread.join(5_000)
        assertTrue(stopCompleted.await(5, TimeUnit.SECONDS), "stop() never completed")

        assertTrue(
            ticker.handles.last().cancelled,
            "stop() left the ticker start() installed running (stop finished ahead of start: $stopFinishedBeforeStart)",
        )
    }
}

/**
 * The production [Ticker]: its executor must actually be released by [Ticker.close], since
 * StreamService (and with it the pipeline and sampler) is rebuilt on every
 * Go Live -> Stop -> Go Live cycle.
 */
class ScheduledExecutorTickerTest {
    @Test
    fun `close shuts down the injected executor`() {
        val executor = Executors.newSingleThreadScheduledExecutor()
        val ticker = ScheduledExecutorTicker(executor)
        ticker.schedule(50) { }

        ticker.close()

        assertTrue(executor.isShutdown, "close() must shut the executor down, not just cancel the scheduled future")
    }

    @Test
    fun `the default executor thread is a daemon so it can never hold the process open`() {
        val ticker = ScheduledExecutorTicker()
        val threadIsDaemon = CompletableFuture<Boolean>()
        try {
            ticker.schedule(10) { threadIsDaemon.complete(Thread.currentThread().isDaemon) }
            assertEquals(true, threadIsDaemon.get(5, TimeUnit.SECONDS))
        } finally {
            ticker.close()
        }
    }
}
