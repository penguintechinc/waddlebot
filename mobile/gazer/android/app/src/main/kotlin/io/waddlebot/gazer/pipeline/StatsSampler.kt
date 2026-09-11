package io.waddlebot.gazer.pipeline

import io.waddlebot.gazer.pigeon.StatsSample
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Schedules periodic StreamEngine polling. Ticking is indirected behind Ticker so
 * StatsSamplerTest/GazerPipelineTest can fire samples deterministically instead of racing a
 * real 1Hz timer.
 */
interface Ticker {
    /** Schedules [task] to run every [periodMs] ms; returns a handle to cancel it. */
    fun schedule(
        periodMs: Long,
        task: () -> Unit,
    ): TickerHandle

    /**
     * Releases the thread/executor resources backing this ticker; it is unusable afterwards.
     * Defaulted to a no-op so the purely in-memory tickers tests inject need not implement it.
     */
    fun close() = Unit
}

/** Cancels a scheduled [Ticker] task. */
interface TickerHandle {
    fun cancel()
}

/**
 * Production Ticker backed by a single-thread scheduled executor.
 *
 * The thread is daemon and the core thread is allowed to time out, so even a caller that forgets
 * [close] cannot strand a non-daemon thread for the life of the process: StreamService - and with
 * it the pipeline and this sampler - is destroyed and rebuilt on every Go Live -> Stop -> Go Live
 * cycle, so a leak here would cost one live thread per streaming session. [close] is still the
 * real fix and is driven from GazerPipeline.dispose() via StatsSampler.shutdown().
 */
class ScheduledExecutorTicker(
    private val executor: ScheduledExecutorService = defaultExecutor(),
) : Ticker {
    private companion object {
        const val KEEP_ALIVE_SECONDS = 5L

        /** Builds the daemon, core-thread-timing-out executor this ticker schedules on. */
        fun defaultExecutor(): ScheduledExecutorService {
            val factory = ThreadFactory { runnable -> Thread(runnable, "gazer-stats-sampler").apply { isDaemon = true } }
            return ScheduledThreadPoolExecutor(1, factory).apply {
                setKeepAliveTime(KEEP_ALIVE_SECONDS, TimeUnit.SECONDS)
                allowCoreThreadTimeOut(true)
            }
        }
    }

    override fun schedule(
        periodMs: Long,
        task: () -> Unit,
    ): TickerHandle {
        val future: ScheduledFuture<*> = executor.scheduleAtFixedRate(task, periodMs, periodMs, TimeUnit.MILLISECONDS)
        return object : TickerHandle {
            override fun cancel() {
                future.cancel(false)
            }
        }
    }

    override fun close() {
        executor.shutdownNow()
    }
}

/**
 * Polls a StreamEngine at [intervalMs] and emits StatsSample values via [onSample]: bitrate
 * from the most recent ConnectChecker.onNewBitrate value (fed through onBitrate), fps from the
 * delta of sentVideoFrames() between ticks, dropped frames and cumulative sent bytes from the
 * engine's counters, and congestion as 0/100 from StreamEngine.hasCongestion(20f).
 *
 * Thread safety: three threads drive this sampler at once - [start] from the Pigeon caller thread
 * (GazerPipeline.start), [stop]/[onBitrate] from RootEncoder's own callback thread
 * (onConnectionFailed/onDisconnect/onAuthError/onNewBitrate), and [tick] from the ticker's
 * executor thread. [start]/[stop]/[shutdown] therefore mutate the handle under [lock]: without it
 * a `stop()` racing a `start()` reads a still-null handle, cancels nothing, and is then overwritten
 * by start()'s own assignment, leaving the ticker running against a released engine - emitting
 * stats to Dart after the stream ended. The sample counters are atomics so the tick thread and the
 * callback thread never lose an update. [lock] is held only across the ticker's own non-blocking
 * schedule/cancel/close calls, never across [onSample].
 */
class StatsSampler(
    private val engine: () -> StreamEngine?,
    private val ticker: Ticker = ScheduledExecutorTicker(),
    private val intervalMs: Long = 1000,
    private val onSample: (StatsSample) -> Unit,
) {
    private val lock = Any()

    @Volatile
    private var handle: TickerHandle? = null
    private val lastBitrateBps = AtomicLong(0)
    private val lastSentVideoFrames = AtomicLong(0)
    private val sentBytesAccumulator = AtomicLong(0)

    /** Feeds the latest ConnectChecker.onNewBitrate(bitrate) value in bits per second. */
    fun onBitrate(bps: Long) {
        lastBitrateBps.set(bps)
    }

    /** Starts periodic sampling; call once per streaming session. */
    fun start() {
        synchronized(lock) {
            handle?.cancel()
            lastSentVideoFrames.set(0)
            sentBytesAccumulator.set(0)
            handle = ticker.schedule(intervalMs) { tick() }
        }
    }

    /** Stops periodic sampling; safe to call repeatedly. */
    fun stop() {
        synchronized(lock) {
            handle?.cancel()
            handle = null
        }
    }

    /**
     * Stops sampling and releases the ticker's executor thread. Call once, when the owning
     * pipeline is torn down for good (GazerPipeline.dispose, from StreamService.onDestroy); the
     * sampler must not be started again afterwards.
     */
    fun shutdown() {
        synchronized(lock) {
            handle?.cancel()
            handle = null
            ticker.close()
        }
    }

    /** Computes and emits one StatsSample from the current engine state; exposed so tests can call ticks manually. */
    fun tick() {
        val current = engine() ?: return
        val sentVideoFrames = current.sentVideoFrames()
        val previousFrames = lastSentVideoFrames.getAndSet(sentVideoFrames)
        val deltaFrames = (sentVideoFrames - previousFrames).coerceAtLeast(0)
        val fps = deltaFrames * 1000.0 / intervalMs
        val droppedVideoFrames = current.droppedVideoFrames()
        val bitrateBps = lastBitrateBps.get()
        val sentBytes = sentBytesAccumulator.addAndGet((bitrateBps / 8.0 * (intervalMs / 1000.0)).toLong())
        val congestionPercent = if (current.hasCongestion(CONGESTION_THRESHOLD_PERCENT)) 100.0 else 0.0
        onSample(
            StatsSample(
                bitrateKbps = bitrateBps / 1000,
                fps = fps,
                droppedVideoFrames = droppedVideoFrames,
                sentBytes = sentBytes,
                congestionPercent = congestionPercent,
            ),
        )
    }
}
