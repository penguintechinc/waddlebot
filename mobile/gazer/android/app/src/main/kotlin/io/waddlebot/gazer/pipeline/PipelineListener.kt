package io.waddlebot.gazer.pipeline

import io.waddlebot.gazer.pigeon.GazerErrorCode
import io.waddlebot.gazer.pigeon.NativePipelineState
import io.waddlebot.gazer.pigeon.StatsSample

/**
 * Sink for GazerPipeline's native-side facts - state transitions, stats samples, and RTMP auth
 * results - so GazerPipeline never depends on Handler/Pigeon directly. PigeonHostApiImpl
 * (Task 20) implements this to post events to Dart on the main thread.
 */
interface PipelineListener {
    fun onState(
        state: NativePipelineState,
        error: GazerErrorCode? = null,
        detail: String? = null,
    )

    fun onStats(sample: StatsSample)

    fun onAuthResult(ok: Boolean)

    /**
     * StreamService has given up its foreground claim and called stopSelf() after an idle failure
     * window, so any client still bound to it must let go: a `BIND_AUTO_CREATE` bind keeps the
     * service alive through stopSelf() and never fires `onServiceDisconnected`, so a client that
     * held on would keep reusing a service that is no longer in the foreground.
     *
     * Defaulted to a no-op: only PigeonHostApiImpl (the bound client) has anything to do here.
     */
    fun onServiceReleased() = Unit
}
