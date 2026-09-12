package io.waddlebot.gazer

import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import io.mockk.clearMocks
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import io.waddlebot.gazer.pigeon.AudioDevice
import io.waddlebot.gazer.pigeon.AudioDeviceKind
import io.waddlebot.gazer.pigeon.GazerErrorCode
import io.waddlebot.gazer.pigeon.GazerFlutterApi
import io.waddlebot.gazer.pigeon.NativePipelineState
import io.waddlebot.gazer.pigeon.OutputOrientation
import io.waddlebot.gazer.pigeon.PrepareResult
import io.waddlebot.gazer.pigeon.StatsSample
import io.waddlebot.gazer.pigeon.StreamConfig
import io.waddlebot.gazer.pigeon.StreamTarget
import io.waddlebot.gazer.pigeon.VideoDevice
import io.waddlebot.gazer.pigeon.VideoDeviceKind
import io.waddlebot.gazer.pipeline.GazerPipeline
import io.waddlebot.gazer.pipeline.PipelineHost
import io.waddlebot.gazer.pipeline.StreamService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTimeoutPreemptively
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.time.Duration

/**
 * GazerHostApi's `@async` methods (`requestUsbPermission`/`prepare`/`start`/`stop`) are Pigeon
 * 28's default `suspend fun` shape (no callback parameter) - see the Pigeon codegen
 * verification note above Task 17. JUnit5 test methods can't be `suspend fun` themselves, so
 * each one wraps its body in `runBlocking { }` (from kotlinx-coroutines-core, already a Task 2
 * dependency). `mainScope` is injected as `Dispatchers.Unconfined` rather than the production
 * default `Dispatchers.Main.immediate`: this plain JVM unit test has no Robolectric/Android
 * Looper, so `Dispatchers.Main` is never installed here - Unconfined runs `launch { }` bodies
 * eagerly on the calling thread, so a `coVerify` immediately after calling
 * `impl.onStats()`/`impl.onAuthResult()` already sees the flutterApi call applied.
 */
class PigeonHostApiImplTest {
    private lateinit var context: Context
    private lateinit var pipeline: GazerPipeline
    private lateinit var flutterApi: GazerFlutterApi
    private lateinit var impl: PigeonHostApiImpl

    private val videoDevice = VideoDevice(id = "camera:back", kind = VideoDeviceKind.BACK_CAMERA, name = "Back camera")
    private val audioDevice = AudioDevice(id = "audio:mic", kind = AudioDeviceKind.MIC, name = "Phone microphone")

    private val config =
        StreamConfig(
            videoDeviceId = "camera:back",
            audioDeviceId = "audio:mic",
            width = 1280L,
            height = 720L,
            fps = 30L,
            videoBitrateKbps = 2000L,
            adaptiveBitrate = true,
            audioBitrateKbps = 128L,
            orientation = OutputOrientation.LANDSCAPE,
        )

    @BeforeEach
    fun setUp() {
        context = mockk(relaxed = true)
        pipeline = mockk(relaxed = true)
        flutterApi = mockk(relaxed = true)
        impl =
            PigeonHostApiImpl(
                context = context,
                flutterApi = flutterApi,
                videoDevices = { listOf(videoDevice) },
                audioDevices = { listOf(audioDevice) },
                mainScope = CoroutineScope(Dispatchers.Unconfined),
            )
        impl.host =
            object : PipelineHost {
                override fun pipeline(): GazerPipeline = pipeline
            }
    }

    @Test
    fun `listVideoDevices returns the injected device list`() {
        assertEquals(listOf(videoDevice), impl.listVideoDevices())
    }

    @Test
    fun `listAudioDevices returns the injected device list`() {
        assertEquals(listOf(audioDevice), impl.listAudioDevices())
    }

    @Test
    fun `requestUsbPermission always resolves false in M1`() =
        runBlocking {
            assertEquals(false, impl.requestUsbPermission("camera:external"))
        }

    @Test
    fun `prepare delegates to the bound pipeline and returns its result`() =
        runBlocking {
            val config =
                StreamConfig(
                    videoDeviceId = "camera:back",
                    audioDeviceId = "audio:mic",
                    width = 1280L,
                    height = 720L,
                    fps = 30L,
                    videoBitrateKbps = 2000L,
                    adaptiveBitrate = true,
                    audioBitrateKbps = 128L,
                    orientation = OutputOrientation.LANDSCAPE,
                )
            every { pipeline.prepare(config) } returns PrepareResult(ok = true)

            val result = impl.prepare(config)

            assertEquals(true, result.ok)
            verify { pipeline.prepare(config) }
        }

    @Test
    fun `start delegates to the bound pipeline`() =
        runBlocking {
            val target = StreamTarget(url = "rtmp://example.com/live/key")

            impl.start(target)

            verify { pipeline.start(target) }
        }

    @Test
    fun `stop delegates to the bound pipeline`() =
        runBlocking {
            impl.stop()

            verify { pipeline.stop() }
        }

    @Test
    fun `setVideoBitrate delegates to the bound pipeline`() {
        impl.setVideoBitrate(3000L)

        verify { pipeline.setVideoBitrate(3000) }
    }

    @Test
    fun `getState returns idle when no service is bound`() {
        impl.host = null

        assertEquals(NativePipelineState.IDLE, impl.getState())
    }

    @Test
    fun `getState delegates to the bound pipeline`() {
        every { pipeline.state } returns NativePipelineState.STREAMING

        assertEquals(NativePipelineState.STREAMING, impl.getState())
    }

    @Test
    fun `onStats calls the Flutter API on the main scope`() {
        val sample = StatsSample(bitrateKbps = 2000L, fps = 30.0, droppedVideoFrames = 0L, sentBytes = 0L, congestionPercent = 0.0)

        impl.onStats(sample)

        coVerify { flutterApi.onStats(sample) }
    }

    @Test
    fun `onAuthResult calls the Flutter API on the main scope`() {
        impl.onAuthResult(true)

        coVerify { flutterApi.onAuthResult(true) }
    }

    @Test
    fun `onServiceConnected ignores a binder that is not StreamService LocalBinder`() {
        impl.host = null

        impl.connection.onServiceConnected(null, mockk<IBinder>(relaxed = true))

        assertNull(impl.host)
    }

    @Test
    fun `onServiceDisconnected clears the bound host`() {
        impl.connection.onServiceDisconnected(null)

        assertNull(impl.host)
    }

    @Test
    fun `prepare binds the service and completes via the real ServiceConnection callback`() =
        runBlocking {
            impl.host = null
            every { pipeline.prepare(config) } returns PrepareResult(ok = true)
            val localBinder = StreamService.LocalBinder(pipelineProvider = { pipeline }, attachListener = {})
            every { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) } answers {
                impl.connection.onServiceConnected(null, localBinder)
                true
            }

            val result = impl.prepare(config)

            assertEquals(true, result.ok)
            verify { pipeline.prepare(config) }
        }

    @Test
    fun `prepare reports SERVICE_START_DENIED when bindService refuses to bind`() =
        runBlocking {
            impl.host = null
            every { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) } returns false

            val result = impl.prepare(config)

            assertEquals(false, result.ok)
            assertEquals(GazerErrorCode.SERVICE_START_DENIED, result.error)
            coVerify { flutterApi.onStateChanged(any()) }
        }

    @Test
    fun `stop unbinds and stops the service, then the next prepare rebinds`() =
        runBlocking {
            impl.host = null
            every { pipeline.prepare(config) } returns PrepareResult(ok = true)
            val localBinder = StreamService.LocalBinder(pipelineProvider = { pipeline }, attachListener = {})
            every { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) } answers {
                impl.connection.onServiceConnected(null, localBinder)
                true
            }

            impl.prepare(config)
            impl.stop()

            verify { pipeline.stop() }
            verify { context.unbindService(impl.connection) }
            assertNull(impl.host)

            impl.prepare(config)

            verify(exactly = 2) { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) }
        }

    @Test
    fun `stop is idempotent - a second call does not unbind or stop again`() =
        runBlocking {
            impl.host = null
            val localBinder = StreamService.LocalBinder(pipelineProvider = { pipeline }, attachListener = {})
            every { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) } answers {
                impl.connection.onServiceConnected(null, localBinder)
                true
            }
            impl.prepare(config)

            impl.stop()
            impl.stop()

            verify(exactly = 1) { context.unbindService(any()) }
        }

    @Test
    fun `prepare gives up with SERVICE_START_DENIED when a started bind never connects`() {
        // bindService() returning true only means binding *began*. If onServiceConnected never
        // fires (service killed during onCreate, foreground start rejected, binder death), an
        // unbounded await here never returns and Dart's prepare() hangs forever with the UI stuck
        // in PreparingState. assertTimeoutPreemptively is what turns that hang into a failure
        // rather than a stalled build.
        val hostApi =
            PigeonHostApiImpl(
                context = context,
                flutterApi = flutterApi,
                videoDevices = { listOf(videoDevice) },
                audioDevices = { listOf(audioDevice) },
                mainScope = CoroutineScope(Dispatchers.Unconfined),
                bindTimeoutMs = 150L,
            )
        every { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) } returns true

        lateinit var result: PrepareResult
        assertTimeoutPreemptively(Duration.ofSeconds(10)) {
            result = runBlocking { hostApi.prepare(config) }
        }

        assertEquals(false, result.ok)
        assertEquals(GazerErrorCode.SERVICE_START_DENIED, result.error)
        verify { context.unbindService(hostApi.connection) }
    }

    @Test
    fun `bindService returning false still unbinds, per the Android ServiceConnection contract`() =
        runBlocking {
            impl.host = null
            every { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) } returns false

            impl.prepare(config)

            verify { context.unbindService(impl.connection) }
        }

    @Test
    fun `dispose releases a prepare still waiting on the bind instead of leaking it`() {
        val hostApi =
            PigeonHostApiImpl(
                context = context,
                flutterApi = flutterApi,
                videoDevices = { listOf(videoDevice) },
                audioDevices = { listOf(audioDevice) },
                mainScope = CoroutineScope(Dispatchers.Unconfined),
                bindTimeoutMs = 60_000L,
            )
        every { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) } returns true

        lateinit var result: PrepareResult
        assertTimeoutPreemptively(Duration.ofSeconds(10)) {
            result =
                runBlocking {
                    val prepare = async { hostApi.prepare(config) }
                    // Let prepare() reach its suspension point before the channel is torn down.
                    while (!hostApi.isAwaitingBind) yield()
                    hostApi.dispose()
                    prepare.await()
                }
        }

        assertEquals(GazerErrorCode.SERVICE_START_DENIED, result.error)
    }

    @Test
    fun `a PipelineListener callback after dispose never reaches the detached Flutter API`() {
        val sample = StatsSample(bitrateKbps = 1L, fps = 1.0, droppedVideoFrames = 0L, sentBytes = 0L, congestionPercent = 0.0)
        impl.dispose()

        impl.onStats(sample)
        impl.onAuthResult(true)
        impl.onState(NativePipelineState.IDLE)

        coVerify(exactly = 0) { flutterApi.onStats(any()) }
        coVerify(exactly = 0) { flutterApi.onAuthResult(any()) }
        coVerify(exactly = 0) { flutterApi.onStateChanged(any()) }
    }

    @Test
    fun `a released service is let go of, so the next prepare re-binds and re-starts it`() =
        runBlocking {
            // NB1: stopSelf() on a service this client still holds with BIND_AUTO_CREATE does not
            // destroy it and never fires onServiceDisconnected, so `host` stayed non-null after the
            // idle-release timer fired - and a manual Go Live from Dart's ErrorState then
            // short-circuited past bindService()/StreamService.start(), streaming from a service
            // with no foreground claim, no notification and no camera|microphone type.
            impl.host = null
            every { pipeline.prepare(config) } returns PrepareResult(ok = true)
            val localBinder = StreamService.LocalBinder(pipelineProvider = { pipeline }, attachListener = {})
            every { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) } answers {
                impl.connection.onServiceConnected(null, localBinder)
                true
            }
            impl.prepare(config)
            verify(exactly = 1) { context.startForegroundService(any()) }

            impl.onServiceReleased()

            assertNull(impl.host, "the released service must be let go of")
            verify(exactly = 1) { context.unbindService(impl.connection) }

            impl.prepare(config)

            verify(exactly = 2) { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) }
            verify(exactly = 2) { context.startForegroundService(any()) }
        }

    @Test
    fun `onServiceReleased is a no-op when nothing is bound`() {
        impl.host = null

        impl.onServiceReleased()

        assertNull(impl.host)
        verify(exactly = 0) { context.unbindService(any()) }
    }

    @Test
    fun `an OS refusal of the foreground service start becomes serviceStartDenied, never a throw`() =
        runBlocking {
            // Android 12+ refuses startForegroundService from the background with
            // ForegroundServiceStartNotAllowedException (an IllegalStateException) and Android 14+
            // with SecurityException. Dart's goLive has no catch around _host.prepare, so an
            // escaping throw would reach the UI as a PlatformException instead of an error state.
            listOf(IllegalStateException("not allowed to start foreground service"), SecurityException("no permission"))
                .forEach { refusal ->
                    impl.host = null
                    clearMocks(context, answers = false)
                    every { context.startForegroundService(any()) } throws refusal

                    val result = impl.prepare(config)

                    assertEquals(false, result.ok)
                    assertEquals(GazerErrorCode.SERVICE_START_DENIED, result.error)
                    verify(exactly = 0) { context.bindService(any<Intent>(), any<ServiceConnection>(), any<Int>()) }
                }
        }

    @Test
    fun `a non-refusal throwable out of the service start still propagates`() {
        // Same shape as startForegroundOrReportDenied's own contract: an OS refusal is expected and
        // mapped, anything else is a bug of ours and must not be swallowed into a generic error.
        impl.host = null
        every { context.startForegroundService(any()) } throws RuntimeException("bug")

        assertThrows(RuntimeException::class.java) { runBlocking { impl.prepare(config) } }
    }

    @Test
    fun `stop never unbinds when the host was injected directly rather than through a real bind`() =
        runBlocking {
            // impl.host is set directly by setUp() (test seam), never via a real bindService()
            // call, so isBound is still false here - stop() must not call unbindService in that
            // case (there is nothing real to unbind).
            impl.stop()

            verify(exactly = 0) { context.unbindService(any()) }
        }
}
