package io.waddlebot.gazer.pipeline

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

/**
 * Pins the M1 TLS posture of the RootEncoder-backed engine (ruling R40), verified against the
 * 2.8.1 artifacts themselves rather than assumed:
 *
 * - `RtmpClient.establishConnection` builds `TcpSocket(socketType, host, port, tlsEnabled,
 *   socketTimeout, tlsHostVerification, certificates)`, with `socketType` defaulting to
 *   `SocketType.JAVA` and `tlsHostVerification`/`certificates` left at `false`/`null`.
 * - `TcpStreamSocketJava.onConnectSocket` therefore does `SSLContext.getInstance("TLS").init(null,
 *   null, SecureRandom())` for `rtmps://` - the chain IS checked against the platform trust store -
 *   but applies `SSLParameters.endpointIdentificationAlgorithm = "HTTPS"` only when
 *   `hostVerification` is true, so hostname verification is OFF by default.
 * - The only switch, `RtmpStreamClient.setTlsHostVerification`, is unreachable through
 *   `GenericStream.getStreamClient()`, which returns a `GenericStreamClient` that does not declare
 *   it and keeps its wrapped `RtmpStreamClient` private.
 *
 * So there is no call this engine can make that would improve the situation, and rtmps:// is
 * rejected Dart-side in M1. What this test defends is the other direction: that nobody later adds
 * a call which *weakens* TLS (a custom TrustManager/HostnameVerifier, `addCertificates`, an
 * `allowAllHostnames`-style switch), and that the removed, misleading `setTlsHostVerification`
 * forwarder - which only re-selected the default trust store via `addCertificates(null)` - does not
 * come back. RootEncoderEngine cannot be instantiated on the JVM unit-test target (its
 * `GenericStream` constructor needs a real Camera2/MediaCodec stack), so the assertion is made
 * against its source, the same way ManifestContentTest asserts against AndroidManifest.xml.
 */
class StreamEngineTlsTest {
    private companion object {
        val SOURCE = File("src/main/kotlin/io/waddlebot/gazer/pipeline/StreamEngine.kt")

        /** Every API that could hand RootEncoder a weaker-than-platform-default TLS configuration. */
        val TLS_WEAKENING_CALLS =
            listOf(
                "addCertificates(",
                "setTlsHostVerification(",
                "TrustManager",
                "HostnameVerifier",
                "SSLContext",
                "setSSLSocketFactory",
            )
    }

    @Test
    fun `the engine source makes no call that could weaken TLS trust or hostname verification`() {
        assertTrue(SOURCE.exists(), "StreamEngine.kt not found at ${SOURCE.absolutePath}")
        val code =
            SOURCE
                .readLines()
                .filterNot { it.trimStart().startsWith("*") || it.trimStart().startsWith("//") || it.trimStart().startsWith("/*") }
                .joinToString("\n")
        // Zero items examined is a failure, not a pass: assert the denominator before the finding.
        assertTrue(code.contains("class RootEncoderEngine"), "scanned the wrong file - RootEncoderEngine not in it")
        val found = TLS_WEAKENING_CALLS.filter { code.contains(it) }
        assertEquals(emptyList<String>(), found, "TLS-affecting call(s) reintroduced into StreamEngine.kt: $found")
    }

    @Test
    fun `the StreamEngine contract exposes no TLS switch an implementation could not honor`() {
        val methods = StreamEngine::class.java.declaredMethods.map { it.name }
        assertTrue(methods.isNotEmpty(), "reflection found no StreamEngine methods - the scan proved nothing")
        assertTrue(
            methods.none { it.contains("Tls", ignoreCase = true) || it.contains("Certificate", ignoreCase = true) },
            "StreamEngine declares a TLS method the RootEncoder implementation cannot honor: $methods",
        )
    }
}
