package io.waddlebot.gazer.pipeline

import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.sources.audio.AudioSource
import com.pedro.encoder.input.sources.video.VideoSource
import io.mockk.clearMocks
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import io.waddlebot.gazer.pigeon.GazerErrorCode
import io.waddlebot.gazer.pigeon.NativePipelineState
import io.waddlebot.gazer.pigeon.OutputOrientation
import io.waddlebot.gazer.pigeon.StatsSample
import io.waddlebot.gazer.pigeon.StreamConfig
import io.waddlebot.gazer.pigeon.StreamTarget
import io.waddlebot.gazer.pipeline.sources.AudioSourceFactory
import io.waddlebot.gazer.pipeline.sources.VideoSourceFactory
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class GazerPipelineTest {
    private lateinit var engine: StreamEngine
    private lateinit var videoSources: VideoSourceFactory
    private lateinit var audioSources: AudioSourceFactory
    private lateinit var listener: PipelineListener
    private lateinit var statsSampler: StatsSampler
    private lateinit var pipeline: GazerPipeline

    private val validConfig =
        StreamConfig(
            videoDeviceId = "camera:back",
            audioDeviceId = "audio:mic",
            width = 1280L,
            height = 720L,
            fps = 30L,
            videoBitrateKbps = 2000L,
            adaptiveBitrate = false,
            audioBitrateKbps = 128L,
            orientation = OutputOrientation.LANDSCAPE,
        )

    @BeforeEach
    fun setUp() {
        engine = mockk(relaxed = true)
        every { engine.prepareVideo(any(), any(), any(), any(), any()) } returns true
        every { engine.prepareAudio(any(), any(), any()) } returns true
        every { engine.hasCongestion(20f) } returns false
        videoSources = mockk(relaxed = true)
        every { videoSources.create(any()) } returns mockk<VideoSource>(relaxed = true)
        audioSources = mockk(relaxed = true)
        every { audioSources.create(any()) } returns mockk<AudioSource>(relaxed = true)
        listener = mockk(relaxed = true)
        statsSampler = mockk(relaxed = true)
        pipeline =
            GazerPipeline(
                engineFactory = { _, _, _ -> engine },
                videoSources = videoSources,
                audioSources = audioSources,
                listener = listener,
                statsSampler = statsSampler,
            )
    }

    @Test
    fun `happy path from prepare through start to streaming`() {
        val result = pipeline.prepare(validConfig)
        assertTrue(result.ok)
        assertEquals(NativePipelineState.READY, pipeline.state)

        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        assertEquals(NativePipelineState.CONNECTING, pipeline.state)

        pipeline.onConnectionSuccess()
        assertEquals(NativePipelineState.STREAMING, pipeline.state)
        verify { listener.onState(NativePipelineState.STREAMING) }
    }

    @Test
    fun `connect failed maps the reason to a GazerErrorCode, reports it, and releases the engine`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))

        pipeline.onConnectionFailed("Connection timeout")

        assertEquals(NativePipelineState.ERROR, pipeline.state)
        verify { listener.onState(NativePipelineState.ERROR, GazerErrorCode.RTMP_CONNECT_FAILED, "Connection timeout") }
        verify(exactly = 1) { engine.release() }
    }

    @Test
    fun `disconnect while streaming reports rtmpDisconnected and releases the engine`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        pipeline.onConnectionSuccess()

        pipeline.onDisconnect()

        assertEquals(NativePipelineState.ERROR, pipeline.state)
        verify { listener.onState(NativePipelineState.ERROR, GazerErrorCode.RTMP_DISCONNECTED, any()) }
        verify(exactly = 1) { engine.release() }
    }

    @Test
    fun `disconnect while connecting goes back to idle`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))

        pipeline.onDisconnect()

        assertEquals(NativePipelineState.IDLE, pipeline.state)
        verify { listener.onState(NativePipelineState.IDLE) }
    }

    @Test
    fun `the trailing disconnect after a failed connect keeps the error and never reports idle`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        pipeline.onConnectionFailed("Connection refused")
        clearMocks(listener, answers = false)

        // RootEncoder always follows a terminal onConnectionFailed with onDisconnect as it tears
        // the socket down. Reporting IDLE for it overwrites the failure Dart has already turned
        // into ReconnectingState: the status chip drops to "Idle" mid-reconnect and the Stop
        // button disappears, leaving no way to cancel the retry loop.
        pipeline.onDisconnect()

        assertEquals(NativePipelineState.ERROR, pipeline.state)
        verify(exactly = 0) { listener.onState(NativePipelineState.IDLE) }
    }

    @Test
    fun `a late onDisconnect from a superseded generation's engine is dropped, not misread as idle`() {
        val checkers = mutableListOf<ConnectChecker>()
        val engine2 = mockk<StreamEngine>(relaxed = true)
        every { engine2.prepareVideo(any(), any(), any(), any(), any()) } returns true
        every { engine2.prepareAudio(any(), any(), any()) } returns true
        every { engine2.hasCongestion(20f) } returns false
        val engines = listOf(engine, engine2).iterator()
        pipeline =
            GazerPipeline(
                engineFactory = { checker, _, _ ->
                    checkers.add(checker)
                    engines.next()
                },
                videoSources = videoSources,
                audioSources = audioSources,
                listener = listener,
                statsSampler = statsSampler,
            )

        // Generation 1: connects, then fails terminally -- the engine is released and the real
        // GazerPipeline.onDisconnect() correctly stays quiet for the trailing callback (state is
        // already ERROR). RootEncoder can still deliver a *second*, delayed onDisconnect for this
        // same released engine well after that, once a reconnect retry has moved on.
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        val firstGenerationChecker = checkers[0]
        firstGenerationChecker.onConnectionFailed("Connection timeout")
        assertEquals(NativePipelineState.ERROR, pipeline.state)

        clearMocks(listener, answers = false)

        // The Dart-side reconnect retry re-prepares: a fresh engine, a fresh generation, moving
        // state to READY.
        pipeline.prepare(validConfig)
        assertEquals(NativePipelineState.READY, pipeline.state)

        // The late onDisconnect for the FIRST (already superseded) engine arrives only now. Keyed
        // on state alone (the pre-7c-fix behaviour) this would match neither wasStreaming nor
        // alreadyFailed and fall into the IDLE branch, overwriting the new session's READY state.
        firstGenerationChecker.onDisconnect()

        assertEquals(NativePipelineState.READY, pipeline.state)
        verify(exactly = 0) { listener.onState(NativePipelineState.IDLE) }
    }

    @Test
    fun `auth error reports rtmpAuthFailed, onAuthResult false, stops sampling, and releases the engine`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))

        pipeline.onAuthError()

        verify { listener.onAuthResult(false) }
        verify { listener.onState(NativePipelineState.ERROR, GazerErrorCode.RTMP_AUTH_FAILED, any()) }
        verify { statsSampler.stop() }
        verify(exactly = 1) { engine.release() }
    }

    @Test
    fun `auth success reports onAuthResult true`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))

        pipeline.onAuthSuccess()

        verify { listener.onAuthResult(true) }
    }

    @Test
    fun `setReTries(0) is always called after a successful prepare`() {
        pipeline.prepare(validConfig)

        verify { engine.setReTries(0) }
    }

    @Test
    fun `adaptive bitrate on invokes setVideoBitrateOnFly via BitrateAdapter on new bitrate`() {
        pipeline.prepare(validConfig.copy(adaptiveBitrate = true))
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        pipeline.onConnectionSuccess()

        // VERIFIED (RootEncoder 2.8.1 BitrateAdapter): the listener only fires once its
        // internal sample counter reaches 5 - a single onNewBitrate tick is not enough with
        // the real BitrateAdapter, so this test drives the real accumulation threshold.
        repeat(5) { pipeline.onNewBitrate(1_500_000L) }

        verify { engine.setVideoBitrateOnFly(any()) }
    }

    @Test
    fun `adaptive bitrate off never calls setVideoBitrateOnFly from onNewBitrate`() {
        pipeline.prepare(validConfig.copy(adaptiveBitrate = false))
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        pipeline.onConnectionSuccess()

        pipeline.onNewBitrate(1_500_000L)

        verify(exactly = 0) { engine.setVideoBitrateOnFly(any()) }
    }

    @Test
    fun `prepare with an invalid config returns a failed PrepareResult`() {
        val result = pipeline.prepare(validConfig.copy(width = 0L))

        assertFalse(result.ok)
        assertEquals(GazerErrorCode.ENCODER_FAILED, result.error)
    }

    @Test
    fun `prepareAudio failure returns audioSourceFailed and releases the engine`() {
        every { engine.prepareVideo(any(), any(), any(), any(), any()) } returns true
        every { engine.prepareAudio(any(), any(), any()) } returns false

        val result = pipeline.prepare(validConfig)

        assertFalse(result.ok)
        assertEquals(GazerErrorCode.AUDIO_SOURCE_FAILED, result.error)
        verify(exactly = 1) { engine.release() }
    }

    @Test
    fun `prepare still returns a failed result even if release throws during video-failure cleanup`() {
        every { engine.prepareVideo(any(), any(), any(), any(), any()) } returns false
        every { engine.release() } throws RuntimeException("boom")

        val result = pipeline.prepare(validConfig)

        assertFalse(result.ok)
        assertEquals(GazerErrorCode.ENCODER_FAILED, result.error)
    }

    @Test
    fun `prepare after an error path releases the previous engine and builds a fresh one`() {
        val engine2 = mockk<StreamEngine>(relaxed = true)
        every { engine2.prepareVideo(any(), any(), any(), any(), any()) } returns true
        every { engine2.prepareAudio(any(), any(), any()) } returns true
        every { engine2.hasCongestion(20f) } returns false
        val engines = listOf(engine, engine2).iterator()
        pipeline =
            GazerPipeline(
                engineFactory = { _, _, _ -> engines.next() },
                videoSources = videoSources,
                audioSources = audioSources,
                listener = listener,
                statsSampler = statsSampler,
            )

        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        pipeline.onConnectionFailed("Connection timeout")

        verify(exactly = 1) { engine.release() }

        val result = pipeline.prepare(validConfig)

        assertTrue(result.ok)
        verify(exactly = 0) { engine2.release() }
    }

    @Test
    fun `stop's blocked engine call does not hold the lock - a concurrent onDisconnect completes first`() {
        val stopStreamEnteredLatch = CountDownLatch(1)
        val proceedLatch = CountDownLatch(1)
        every { engine.stopStream() } answers {
            stopStreamEnteredLatch.countDown()
            proceedLatch.await(5, TimeUnit.SECONDS)
            true
        }
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        pipeline.onConnectionSuccess()

        val stopError = AtomicReference<Throwable?>()
        val stopThread =
            Thread {
                try {
                    pipeline.stop()
                } catch (t: Throwable) {
                    stopError.set(t)
                }
            }
        stopThread.start()
        // stop() has already snapshotted+cleared the engine field and released the lock by the
        // time it calls the (now-blocked) engine.stopStream() - a concurrent onDisconnect() must
        // therefore be able to acquire the lock and complete immediately, proving no monitor is
        // held across the engine call.
        assertTrue(stopStreamEnteredLatch.await(5, TimeUnit.SECONDS))

        val disconnectCompleted = CountDownLatch(1)
        val disconnectError = AtomicReference<Throwable?>()
        val disconnectThread =
            Thread {
                try {
                    pipeline.onDisconnect()
                } catch (t: Throwable) {
                    disconnectError.set(t)
                } finally {
                    disconnectCompleted.countDown()
                }
            }
        disconnectThread.start()

        assertTrue(
            disconnectCompleted.await(2, TimeUnit.SECONDS),
            "onDisconnect() blocked - the lock was held across engine.stopStream()",
        )

        proceedLatch.countDown()
        stopThread.join(5_000)
        disconnectThread.join(5_000)

        assertNull(stopError.get())
        assertNull(disconnectError.get())
    }

    @Test
    fun `a listener that re-enters the pipeline synchronously from onState does not deadlock`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        every { listener.onState(NativePipelineState.ERROR, any(), any()) } answers {
            pipeline.stop()
        }

        pipeline.onConnectionFailed("Connection timeout")

        assertEquals(NativePipelineState.IDLE, pipeline.state)
    }

    @Test
    fun `start from the wrong state reports onState error unknown`() {
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))

        verify { listener.onState(NativePipelineState.ERROR, GazerErrorCode.UNKNOWN, any()) }
    }

    @Test
    fun `stop from any state returns to idle via stopping`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        pipeline.onConnectionSuccess()

        pipeline.stop()

        assertEquals(NativePipelineState.IDLE, pipeline.state)
        verify { listener.onState(NativePipelineState.STOPPING) }
        verify { listener.onState(NativePipelineState.IDLE) }
        verify { engine.stopStream() }
        verify { engine.release() }
    }

    @Test
    fun `onConnectionStarted reports connecting`() {
        pipeline.prepare(validConfig)

        pipeline.onConnectionStarted("rtmp://example.com/live/key")

        assertEquals(NativePipelineState.CONNECTING, pipeline.state)
    }

    @Test
    fun `setVideoBitrate clamps to the 500 to 5000 kbps range`() {
        pipeline.prepare(validConfig)

        pipeline.setVideoBitrate(100)
        verify { engine.setVideoBitrateOnFly(500_000) }

        pipeline.setVideoBitrate(9000)
        verify { engine.setVideoBitrateOnFly(5_000_000) }
    }

    @Test
    fun `start hands the target's credentials to the engine before connecting`() {
        pipeline.prepare(validConfig)

        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key", username = "publisher", password = "secret"))

        verify { engine.setAuthorization("publisher", "secret") }
        verify { engine.startStream("rtmp://example.com/live/key") }
    }

    @Test
    fun `a second prepare releases the still-held engine before building a new one`() {
        // Without the snapshot-and-release at the top of prepare(), the first engine - holding a
        // configured MediaCodec and an open Camera2Source - is simply overwritten, and the *next*
        // session fails with a camera-in-use error. Only Dart's session epoch prevented this
        // before; releasing a superseded engine is resource hygiene, not policy.
        val engine2 = mockk<StreamEngine>(relaxed = true)
        every { engine2.prepareVideo(any(), any(), any(), any(), any()) } returns true
        every { engine2.prepareAudio(any(), any(), any()) } returns true
        val engines = listOf(engine, engine2).iterator()
        pipeline = pipelineWith { _, _, _ -> engines.next() }

        assertTrue(pipeline.prepare(validConfig).ok)
        verify(exactly = 0) { engine.release() }

        assertTrue(pipeline.prepare(validConfig).ok)

        assertEquals(NativePipelineState.READY, pipeline.state)
        verify(exactly = 1) { engine.release() }
        verify(exactly = 0) { engine2.release() }
    }

    @Test
    fun `a second prepare survives a superseded engine whose release throws`() {
        val engine2 = mockk<StreamEngine>(relaxed = true)
        every { engine2.prepareVideo(any(), any(), any(), any(), any()) } returns true
        every { engine2.prepareAudio(any(), any(), any()) } returns true
        every { engine.release() } throws RuntimeException("boom")
        val engines = listOf(engine, engine2).iterator()
        pipeline = pipelineWith { _, _, _ -> engines.next() }
        pipeline.prepare(validConfig)

        assertTrue(pipeline.prepare(validConfig).ok)
    }

    @Test
    fun `prepare's release of the superseded engine does not hold the lock`() {
        // R28: engine calls always happen outside the monitor. Blocking inside release() must not
        // stop a concurrent RootEncoder callback from acquiring the lock and completing.
        val releaseEntered = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        every { engine.release() } answers {
            releaseEntered.countDown()
            proceed.await(5, TimeUnit.SECONDS)
        }
        val engine2 = mockk<StreamEngine>(relaxed = true)
        every { engine2.prepareVideo(any(), any(), any(), any(), any()) } returns true
        every { engine2.prepareAudio(any(), any(), any()) } returns true
        val engines = listOf(engine, engine2).iterator()
        pipeline = pipelineWith { _, _, _ -> engines.next() }
        pipeline.prepare(validConfig)

        val prepareThread = Thread { pipeline.prepare(validConfig) }
        prepareThread.start()
        assertTrue(releaseEntered.await(5, TimeUnit.SECONDS))

        val callbackCompleted = CountDownLatch(1)
        Thread {
            pipeline.onNewBitrate(1_000L)
            callbackCompleted.countDown()
        }.start()

        assertTrue(
            callbackCompleted.await(2, TimeUnit.SECONDS),
            "onNewBitrate() blocked - the lock was held across the superseded engine's release()",
        )
        proceed.countDown()
        prepareThread.join(5_000)
    }

    @Test
    fun `a throwing video source factory reports encoderFailed instead of escaping to Pigeon`() {
        every { videoSources.create(any()) } throws IllegalArgumentException("Unknown video device id: camera:back")

        // An escaping exception fails this test on its own - that is exactly the old behavior.
        val result = pipeline.prepare(validConfig)

        assertFalse(result.ok)
        assertEquals(GazerErrorCode.ENCODER_FAILED, result.error)
        assertEquals(NativePipelineState.ERROR, pipeline.state)
        verify { listener.onState(NativePipelineState.ERROR, GazerErrorCode.ENCODER_FAILED, any()) }
    }

    @Test
    fun `a throwing audio source factory reports audioSourceFailed instead of escaping to Pigeon`() {
        every { audioSources.create(any()) } throws IllegalArgumentException("Unknown audio device id: audio:mic")

        // An escaping exception fails this test on its own - that is exactly the old behavior.
        val result = pipeline.prepare(validConfig)

        assertFalse(result.ok)
        assertEquals(GazerErrorCode.AUDIO_SOURCE_FAILED, result.error)
        assertEquals(NativePipelineState.ERROR, pipeline.state)
    }

    @Test
    fun `a throwing engine factory reports encoderFailed instead of escaping to Pigeon`() {
        pipeline = pipelineWith { _, _, _ -> throw IllegalStateException("MediaCodec unavailable") }

        // An escaping exception fails this test on its own - that is exactly the old behavior.
        val result = pipeline.prepare(validConfig)

        assertFalse(result.ok)
        assertEquals(GazerErrorCode.ENCODER_FAILED, result.error)
        assertEquals(NativePipelineState.ERROR, pipeline.state)
    }

    @Test
    fun `a throwing startStream reports ERROR and releases the engine instead of escaping to Pigeon`() {
        // Left unguarded, this reaches Dart as a PlatformException while the pipeline sits at
        // CONNECTING with a leaked engine and a running sampler: the UI sticks in ConnectingState,
        // where canGoLive is false - unrecoverable without an app restart.
        every { engine.startStream(any()) } throws RuntimeException("rtmp://user:key@host refused")
        pipeline.prepare(validConfig)

        assertDoesNotThrow { pipeline.start(StreamTarget(url = "rtmp://example.com/live/key")) }

        assertEquals(NativePipelineState.ERROR, pipeline.state)
        verify { listener.onState(NativePipelineState.ERROR, GazerErrorCode.RTMP_CONNECT_FAILED, any()) }
        verify { statsSampler.stop() }
        verify(exactly = 1) { engine.release() }
    }

    @Test
    fun `the detail of a start failure never carries the throwable's message`() {
        // RootEncoder embeds the target URL - and therefore the stream key - in its exception
        // messages, and `detail` is relayed to Dart and rendered in the UI.
        val details = mutableListOf<String?>()
        val recording =
            object : PipelineListener {
                override fun onState(
                    state: NativePipelineState,
                    error: GazerErrorCode?,
                    detail: String?,
                ) {
                    details.add(detail)
                }

                override fun onStats(sample: StatsSample) = Unit

                override fun onAuthResult(ok: Boolean) = Unit
            }
        every { engine.startStream(any()) } throws RuntimeException("failed publishing to rtmp://host/live/SUPERSECRETKEY")
        val recordingPipeline =
            GazerPipeline(
                engineFactory = { _, _, _ -> engine },
                videoSources = videoSources,
                audioSources = audioSources,
                listener = recording,
                statsSampler = statsSampler,
            )
        recordingPipeline.prepare(validConfig)

        recordingPipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))

        assertTrue(details.isNotEmpty())
        details.forEach { assertFalse(it.orEmpty().contains("SUPERSECRETKEY")) }
    }

    @Test
    fun `a throwing setAuthorization reports ERROR instead of escaping to Pigeon`() {
        every { engine.setAuthorization(any(), any()) } throws RuntimeException("boom")
        pipeline.prepare(validConfig)

        assertDoesNotThrow { pipeline.start(StreamTarget(url = "rtmp://example.com/live/key", username = "u", password = "p")) }

        assertEquals(NativePipelineState.ERROR, pipeline.state)
        verify(exactly = 0) { engine.startStream(any()) }
    }

    @Test
    fun `stop supersedes the generation so the released engine's trailing callback cannot overwrite IDLE`() {
        val checkers = mutableListOf<ConnectChecker>()
        pipeline =
            pipelineWith { checker, _, _ ->
                checkers.add(checker)
                engine
            }
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))
        pipeline.onConnectionSuccess()

        pipeline.stop()
        assertEquals(NativePipelineState.IDLE, pipeline.state)
        clearMocks(listener, statsSampler, answers = false)

        // RootEncoder delivers onDisconnect as it tears the socket down, after stop() has already
        // reported IDLE. Without a generation bump in stop() this callback still passes isCurrent
        // and re-reports IDLE for a session that is already over - a spurious event Dart has to
        // absorb, and one that becomes an ERROR after IDLE as soon as the timing shifts.
        checkers.single().onDisconnect()

        assertEquals(NativePipelineState.IDLE, pipeline.state)
        verify(exactly = 0) { listener.onState(NativePipelineState.IDLE) }
        verify(exactly = 0) { listener.onState(NativePipelineState.ERROR, any(), any()) }
        verify(exactly = 0) { statsSampler.stop() }
    }

    @Test
    fun `dispose stops the pipeline and shuts the stats sampler's executor down`() {
        pipeline.prepare(validConfig)
        pipeline.start(StreamTarget(url = "rtmp://example.com/live/key"))

        pipeline.dispose()

        assertEquals(NativePipelineState.IDLE, pipeline.state)
        verify { engine.release() }
        verify { statsSampler.shutdown() }
    }

    /** Rebuilds [pipeline] with [engineFactory], keeping every other collaborator from [setUp]. */
    private fun pipelineWith(engineFactory: (ConnectChecker, VideoSource, AudioSource) -> StreamEngine): GazerPipeline =
        GazerPipeline(
            engineFactory = engineFactory,
            videoSources = videoSources,
            audioSources = audioSources,
            listener = listener,
            statsSampler = statsSampler,
        )
}
