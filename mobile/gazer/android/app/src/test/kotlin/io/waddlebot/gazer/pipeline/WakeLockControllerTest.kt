package io.waddlebot.gazer.pipeline

import io.waddlebot.gazer.pigeon.NativePipelineState
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * WakeLockController's acquire/release decision is injected as plain lambdas (never a real
 * PowerManager), so this pure decision table is fully covered here without StreamService's own
 * Android-framework-bound plumbing.
 */
class WakeLockControllerTest {
    @Test
    fun `STREAMING acquires the wake lock`() {
        var acquired = 0
        var released = 0
        val controller = WakeLockController(acquire = { acquired++ }, release = { released++ })

        controller.onState(NativePipelineState.STREAMING)

        assertEquals(1, acquired)
        assertEquals(0, released)
    }

    @Test
    fun `every state that ends the stream releases the wake lock`() {
        // ERROR is the one that matters in practice: when Dart exhausts its reconnect budget it
        // settles on ErrorState without ever driving the pipeline back to IDLE, so releasing only
        // on IDLE left the PARTIAL_WAKE_LOCK held until its 4-hour timeout with nothing streaming.
        listOf(NativePipelineState.IDLE, NativePipelineState.STOPPING, NativePipelineState.ERROR).forEach { state ->
            var acquired = 0
            var released = 0
            val controller = WakeLockController(acquire = { acquired++ }, release = { released++ })

            controller.onState(state)

            assertEquals(0, acquired, "$state must not acquire")
            assertEquals(1, released, "$state must release the wake lock")
        }
    }

    @Test
    fun `every other state is a no-op`() {
        val terminal =
            setOf(
                NativePipelineState.STREAMING,
                NativePipelineState.IDLE,
                NativePipelineState.STOPPING,
                NativePipelineState.ERROR,
            )
        var acquired = 0
        var released = 0
        val controller = WakeLockController(acquire = { acquired++ }, release = { released++ })

        NativePipelineState.entries.filterNot { it in terminal }.forEach { controller.onState(it) }

        assertEquals(0, acquired)
        assertEquals(0, released)
    }
}
