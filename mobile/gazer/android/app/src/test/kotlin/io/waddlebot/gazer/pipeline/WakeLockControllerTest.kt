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
    fun `a deliberate stop releases the wake lock`() {
        listOf(NativePipelineState.IDLE, NativePipelineState.STOPPING).forEach { state ->
            var acquired = 0
            var released = 0
            val controller = WakeLockController(acquire = { acquired++ }, release = { released++ })

            controller.onState(state)

            assertEquals(0, acquired, "$state must not acquire")
            assertEquals(1, released, "$state must release the wake lock")
        }
    }

    @Test
    fun `ERROR keeps the wake lock, so a reconnect backoff cannot be slept through`() {
        // Kotlin cannot tell a transient ERROR - the first blip of a Dart-driven reconnect, which
        // sleeps through a backoff and then re-prepares - from a terminal one. Releasing here let
        // the device sleep through that backoff and stall the retry; the "held forever after a
        // terminal failure" half is ServiceTeardownController's bounded idle-release timer's job.
        var acquired = 0
        var released = 0
        val controller = WakeLockController(acquire = { acquired++ }, release = { released++ })

        controller.onState(NativePipelineState.ERROR)

        assertEquals(0, acquired)
        assertEquals(0, released)
    }

    @Test
    fun `every other state is a no-op`() {
        val handled =
            setOf(
                NativePipelineState.STREAMING,
                NativePipelineState.IDLE,
                NativePipelineState.STOPPING,
            )
        var acquired = 0
        var released = 0
        val controller = WakeLockController(acquire = { acquired++ }, release = { released++ })

        NativePipelineState.entries.filterNot { it in handled }.forEach { controller.onState(it) }

        assertEquals(0, acquired)
        assertEquals(0, released)
    }
}
