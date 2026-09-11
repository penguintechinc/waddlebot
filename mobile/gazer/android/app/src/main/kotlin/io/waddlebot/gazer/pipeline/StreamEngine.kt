package io.waddlebot.gazer.pipeline

import android.content.Context
import com.pedro.common.ConnectChecker
import com.pedro.encoder.input.sources.audio.AudioSource
import com.pedro.encoder.input.sources.video.VideoSource
import com.pedro.library.generic.GenericStream

/**
 * Percentage of the stream client's send queue that must be occupied before
 * [StreamEngine.hasCongestion] reports congestion. Shared by GazerPipeline (which feeds
 * BitrateAdapter) and StatsSampler (which reports it to Dart) so the two can never drift apart
 * and report different congestion for the same instant.
 */
internal const val CONGESTION_THRESHOLD_PERCENT = 20f

/**
 * Bridge between GazerPipeline and whatever RTMP/H.264 implementation backs it. Exists so
 * GazerPipeline's state machine and tests never touch RootEncoder types directly - only this
 * narrow surface, verified against RootEncoder 2.8.1's StreamBase and GenericStreamClient.
 */
interface StreamEngine {
    fun prepareVideo(
        width: Int,
        height: Int,
        bitrateBps: Int,
        fps: Int,
        rotation: Int,
    ): Boolean

    fun prepareAudio(
        sampleRate: Int,
        stereo: Boolean,
        bitrateBps: Int,
    ): Boolean

    fun startStream(url: String)

    fun stopStream(): Boolean

    fun setVideoBitrateOnFly(bitrateBps: Int)

    fun setAuthorization(
        user: String?,
        password: String?,
    )

    fun setReTries(n: Int)

    fun sentVideoFrames(): Long

    fun droppedVideoFrames(): Long

    fun hasCongestion(percentUsed: Float): Boolean

    fun release()
}

/**
 * Wraps RootEncoder's GenericStream (Camera2/Mic -> MediaCodec H.264/AAC -> RTMP) behind
 * StreamEngine. Deliberately thin: every method is a 1:1 forward to a verified RootEncoder 2.8.1
 * API, so GazerPipelineTest exercises this class only indirectly via a fake StreamEngine -
 * RootEncoderEngine's real runtime coverage is the on-emulator
 * `integration_test/go_live_unreachable_test.dart`, which drives prepare -> startStream -> failure
 * -> re-prepare against a real Camera2/MediaCodec/socket stack.
 *
 * TLS, VERIFIED against the 2.8.1 artifacts (decompiled from the Gradle cache; see the M1 fix-wave
 * Android report for the exact bytecode citations):
 * - `RtmpClient.establishConnection` builds `TcpSocket(socketType, host, port, tlsEnabled,
 *   socketTimeout, tlsHostVerification, certificates)`; `socketType` defaults to `SocketType.JAVA`
 *   and both `tlsHostVerification` and `certificates` are left at their Kotlin defaults
 *   (`false`/`null`) unless a caller changes them.
 * - `TcpStreamSocketJava.onConnectSocket` therefore does `SSLContext.getInstance("TLS").init(null,
 *   null, SecureRandom())` for an `rtmps://` target: the **certificate chain IS validated** against
 *   the platform trust store, but `SSLParameters.endpointIdentificationAlgorithm = "HTTPS"` is only
 *   applied when `hostVerification` is true - so **hostname verification is OFF by default**.
 * - The only switch for it, `RtmpStreamClient.setTlsHostVerification`, is unreachable from here:
 *   `GenericStream.getStreamClient()` returns `GenericStreamClient`, which exposes
 *   `addCertificates` but not `setTlsHostVerification`, and keeps its wrapped `RtmpStreamClient`
 *   private.
 * Consequence: `rtmps://` through `GenericStream` does not meet `security.md`'s certificate
 * validation bar in M1 and must be rejected by Dart's TargetValidator. This class deliberately
 * makes no TLS call at all - there is none it could make that would help - and the dead
 * `setTlsHostVerification` forwarder that used to sit here (it only called `addCertificates(null)`,
 * i.e. re-selected the default trust store) has been removed so nobody believes it is wired.
 */
class RootEncoderEngine(
    context: Context,
    connectChecker: ConnectChecker,
    videoSource: VideoSource,
    audioSource: AudioSource,
) : StreamEngine {
    private val stream = GenericStream(context, connectChecker, videoSource, audioSource)

    override fun prepareVideo(
        width: Int,
        height: Int,
        bitrateBps: Int,
        fps: Int,
        rotation: Int,
    ): Boolean = stream.prepareVideo(width, height, bitrateBps, fps, rotation = rotation)

    override fun prepareAudio(
        sampleRate: Int,
        stereo: Boolean,
        bitrateBps: Int,
    ): Boolean = stream.prepareAudio(sampleRate, stereo, bitrateBps)

    override fun startStream(url: String) {
        stream.startStream(url)
    }

    override fun stopStream(): Boolean = stream.stopStream()

    override fun setVideoBitrateOnFly(bitrateBps: Int) {
        stream.setVideoBitrateOnFly(bitrateBps)
    }

    override fun setAuthorization(
        user: String?,
        password: String?,
    ) {
        stream.getStreamClient().setAuthorization(user, password)
    }

    override fun setReTries(n: Int) {
        stream.getStreamClient().setReTries(n)
    }

    override fun sentVideoFrames(): Long = stream.getStreamClient().getSentVideoFrames()

    override fun droppedVideoFrames(): Long = stream.getStreamClient().getDroppedVideoFrames()

    override fun hasCongestion(percentUsed: Float): Boolean = stream.getStreamClient().hasCongestion(percentUsed)

    override fun release() {
        stream.release()
    }
}
