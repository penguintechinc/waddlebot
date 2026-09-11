package io.waddlebot.gazer

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import io.waddlebot.gazer.pigeon.AudioDevice
import io.waddlebot.gazer.pigeon.GazerErrorCode
import io.waddlebot.gazer.pigeon.GazerFlutterApi
import io.waddlebot.gazer.pigeon.GazerHostApi
import io.waddlebot.gazer.pigeon.NativePipelineState
import io.waddlebot.gazer.pigeon.PrepareResult
import io.waddlebot.gazer.pigeon.StateEvent
import io.waddlebot.gazer.pigeon.StatsSample
import io.waddlebot.gazer.pigeon.StreamConfig
import io.waddlebot.gazer.pigeon.StreamTarget
import io.waddlebot.gazer.pigeon.VideoDevice
import io.waddlebot.gazer.pipeline.GazerPipeline
import io.waddlebot.gazer.pipeline.PipelineHost
import io.waddlebot.gazer.pipeline.PipelineListener
import io.waddlebot.gazer.pipeline.StreamService
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Implements the Pigeon GazerHostApi: binds/starts StreamService on prepare(), forwards every
 * command to the bound GazerPipeline, and relays PipelineListener facts back to Dart via
 * GazerFlutterApi. Pigeon 28 generates `@async` GazerHostApi methods as plain `suspend fun` (no
 * callback parameter) - the generated `setUp` wrapper already runs each call in its own
 * `CoroutineScope(Dispatchers.Main).launch { }` and replies with the result or a caught
 * exception, so this class never manages that scope itself. GazerFlutterApi is generated the
 * same way (its methods are `suspend fun` too), which is why every `PipelineListener` callback
 * below runs inside [mainScope] instead of a `Handler.post { }` callback.
 */
class PigeonHostApiImpl(
    private val context: Context,
    private val flutterApi: GazerFlutterApi,
    private val videoDevices: () -> List<VideoDevice>,
    private val audioDevices: () -> List<AudioDevice>,
    private val mainScope: CoroutineScope = CoroutineScope(Dispatchers.Main.immediate),
    private val bindTimeoutMs: Long = DEFAULT_BIND_TIMEOUT_MS,
) : GazerHostApi,
    PipelineListener {
    companion object {
        /**
         * How long [prepare] waits for StreamService's ServiceConnection after a successful
         * bindService() before giving up and reporting SERVICE_START_DENIED. A local bind to an
         * own-process service normally connects within a frame or two; anything near this budget
         * means the service never came up (killed during onCreate, foreground start rejected,
         * binder death), and Dart must be told rather than left suspended forever.
         */
        const val DEFAULT_BIND_TIMEOUT_MS = 5_000L

        /** Single `detail` string for every "the service never became usable" prepare failure. */
        private const val BIND_FAILED_DETAIL = "StreamService bind failed"
    }

    /** Test/composition seam - `internal` so PigeonHostApiImplTest can inject a fake without a real ServiceConnection. */
    internal var host: PipelineHost? = null
    private var hostDeferred: CompletableDeferred<PipelineHost?>? = null

    /**
     * Test seam - `internal` so PigeonHostApiImplTest can wait for a `prepare()` to actually reach
     * its suspension point before driving dispose()/onServiceConnected against it, instead of
     * racing the coroutine.
     */
    internal val isAwaitingBind: Boolean get() = hostDeferred != null

    /**
     * Tracks whether this instance currently owns an active `bindService()` call that must be
     * matched with exactly one `unbindService()` - set the moment `bindService()` returns true
     * (per the Android contract, regardless of whether `onServiceConnected` has fired yet), and
     * cleared once `unbindIfBound()` actually unbinds. `host != null` is not a substitute for
     * this: `host` is also set directly in tests without a real bind ever happening.
     */
    private var isBound = false

    /**
     * Test seam - `internal` so PigeonHostApiImplTest can drive onServiceConnected/
     * onServiceDisconnected directly with a real StreamService.LocalBinder.
     */
    internal val connection =
        object : ServiceConnection {
            override fun onServiceConnected(
                name: ComponentName?,
                binder: IBinder?,
            ) {
                val serviceBinder = binder as? StreamService.LocalBinder ?: return
                serviceBinder.setListener(this@PigeonHostApiImpl)
                val boundHost =
                    object : PipelineHost {
                        override fun pipeline(): GazerPipeline = serviceBinder.pipeline
                    }
                host = boundHost
                hostDeferred?.complete(boundHost)
                hostDeferred = null
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                host = null
            }
        }

    override fun listVideoDevices(): List<VideoDevice> = videoDevices()

    override fun listAudioDevices(): List<AudioDevice> = audioDevices()

    override suspend fun requestUsbPermission(deviceId: String): Boolean {
        // M1 lists no USB devices; always deny so Dart's UI never offers a USB source.
        return false
    }

    override suspend fun prepare(config: StreamConfig): PrepareResult {
        val currentHost = host ?: awaitBoundHost()
        if (currentHost == null) {
            postState(NativePipelineState.ERROR, GazerErrorCode.SERVICE_START_DENIED, BIND_FAILED_DETAIL)
            return PrepareResult(ok = false, error = GazerErrorCode.SERVICE_START_DENIED, detail = BIND_FAILED_DETAIL)
        }
        return currentHost.pipeline().prepare(config)
    }

    override suspend fun start(target: StreamTarget) {
        host?.pipeline()?.start(target)
    }

    override suspend fun stop() {
        host?.pipeline()?.stop()
        unbindIfBound()
        StreamService.stop(context)
        host = null
    }

    override fun setVideoBitrate(kbps: Long) {
        host?.pipeline()?.setVideoBitrate(kbps.toInt())
    }

    override fun getState(): NativePipelineState = host?.pipeline()?.state ?: NativePipelineState.IDLE

    /**
     * Binds StreamService and suspends until its ServiceConnection connects. Returns null when
     * bindService() refuses to even start binding, and also when it started one that never
     * connected within [bindTimeoutMs] - bindService() returning true only means binding *began*,
     * so an unbounded await here hangs Dart's prepare() forever (silent UI stall in PreparingState)
     * if onServiceConnected never fires: service killed during onCreate, foreground start rejected,
     * or binder death before the connection. Both cases map to the same SERVICE_START_DENIED path.
     */
    private suspend fun awaitBoundHost(): PipelineHost? {
        val deferred = CompletableDeferred<PipelineHost?>()
        hostDeferred = deferred
        val bound = bindService()
        if (!bound) {
            hostDeferred = null
            return null
        }
        val boundHost = withTimeoutOrNull(bindTimeoutMs) { deferred.await() }
        if (boundHost == null) {
            hostDeferred = null
            unbindIfBound()
        }
        return boundHost
    }

    private fun bindService(): Boolean {
        StreamService.start(context)
        val bound = context.bindService(Intent(context, StreamService::class.java), connection, Context.BIND_AUTO_CREATE)
        isBound = bound
        // Per the Android contract, a bindService() that returns false still leaves the
        // ServiceConnection registered and must be matched with unbindService(); skipping it leaks
        // the connection (and logs a ServiceConnection leak warning) for the life of the process.
        if (!bound) runCatching { context.unbindService(connection) }
        return bound
    }

    /** Unbinds StreamService if this instance currently owns an active bind; safe (no-op) otherwise, and idempotent. */
    private fun unbindIfBound() {
        if (!isBound) return
        runCatching { context.unbindService(connection) }
        isBound = false
    }

    /**
     * Cancels [mainScope] and unbinds StreamService if still bound. Call exactly once, when the
     * platform channel itself is being torn down (GazerFlutterBindings.uninstall) - after this,
     * no further PipelineListener callback can reach a detached GazerFlutterApi/BinaryMessenger.
     */
    fun dispose() {
        unbindIfBound()
        host = null
        // A prepare() still suspended on awaitBoundHost() belongs to Pigeon's own coroutine scope,
        // not mainScope, so cancelling mainScope would leave it parked on a deferred nobody will
        // ever complete. Complete it with null instead (never cancel(): a CancellationException out
        // of await() would escape prepare() as a Pigeon PlatformException) - the suspended prepare()
        // resumes, maps the null host to SERVICE_START_DENIED, and its coroutine finishes.
        hostDeferred?.complete(null)
        hostDeferred = null
        mainScope.cancel()
    }

    // PipelineListener - each call launches on mainScope, since GazerFlutterApi's methods are
    // suspend functions (Pigeon 28 default for @FlutterApi) that must run on the main thread,
    // the same thread platform channel messages are always sent from.

    override fun onState(
        state: NativePipelineState,
        error: GazerErrorCode?,
        detail: String?,
    ) {
        postState(state, error, detail)
    }

    override fun onStats(sample: StatsSample) {
        mainScope.launch { flutterApi.onStats(sample) }
    }

    override fun onAuthResult(ok: Boolean) {
        mainScope.launch { flutterApi.onAuthResult(ok) }
    }

    private fun postState(
        state: NativePipelineState,
        error: GazerErrorCode?,
        detail: String?,
    ) {
        mainScope.launch { flutterApi.onStateChanged(StateEvent(state = state, error = error, detail = detail)) }
    }
}
