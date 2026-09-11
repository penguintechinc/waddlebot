package io.waddlebot.gazer.pipeline

import io.mockk.every
import io.mockk.mockk
import io.waddlebot.gazer.pigeon.StatsSample
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private class FakeTicker : Ticker {
    var scheduledTask: (() -> Unit)? = null
    var cancelled = false
    var closed = false

    /** Latched inside [schedule] so a test can park a start() mid-flight and race a stop() with it. */
    var scheduleGate: CountDownLatch? = null
    val scheduleEntered = CountDownLatch(1)

    override fun schedule(
        periodMs: Long,
        task: () -> Unit,
    ): TickerHandle {
        scheduleEntered.countDown()
        scheduleGate?.await(5, TimeUnit.SECONDS)
        scheduledTask = task
        return object : TickerHandle {
            override fun cancel() {
                cancelled = true
            }
        }
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
    fun `a stop racing an in-flight start still cancels the ticker`() {
        // start() and stop() run on different threads in production: start() from the Pigeon caller
        // thread (GazerPipeline.start) and stop() from RootEncoder's callback thread
        // (onConnectionFailed/onDisconnect/onAuthError). With unguarded fields, a stop() that lands
        // while start() is still inside ticker.schedule() reads a null handle, cancels nothing, and
        // is then overwritten by start()'s own assignment - leaving the ticker running forever
        // against a released engine. Parking schedule() on a latch makes that interleaving exact
        // rather than a coin flip.
        val ticker = FakeTicker()
        val gate = CountDownLatch(1)
        ticker.scheduleGate = gate
        val sampler = StatsSampler(engine = { null }, ticker = ticker) { }

        val startThread = Thread { sampler.start() }
        startThread.start()
        assertTrue(ticker.scheduleEntered.await(5, TimeUnit.SECONDS), "start() never reached ticker.schedule()")

        val stopCompleted = CountDownLatch(1)
        val stopThread =
            Thread {
                sampler.stop()
                stopCompleted.countDown()
            }
        stopThread.start()
        gate.countDown()
        assertTrue(stopCompleted.await(5, TimeUnit.SECONDS), "stop() never completed")
        startThread.join(5_000)
        stopThread.join(5_000)

        assertTrue(ticker.cancelled, "the ticker survived a stop() that raced start() - sampling would never end")
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
