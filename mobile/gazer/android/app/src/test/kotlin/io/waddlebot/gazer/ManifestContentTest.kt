package io.waddlebot.gazer

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.w3c.dom.Document
import org.w3c.dom.Element
import java.io.File
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Parses the real AndroidManifest.xml from source with a plain XML DOM parser (no Android
 * framework, no Robolectric) and asserts the M1-required permissions, the StreamService
 * foreground-service declaration, and the M1 no-USB constraint. Exists so a manifest
 * regression (missing permission, wrong service flags) fails a JVM unit test instead of only
 * surfacing at runtime on-device.
 */
class ManifestContentTest {
    companion object {
        private lateinit var document: Document

        @BeforeAll
        @JvmStatic
        fun loadManifest() {
            val manifestFile = File("src/main/AndroidManifest.xml")
            require(manifestFile.exists()) { "AndroidManifest.xml not found at ${manifestFile.absolutePath}" }
            // Secure-processing + no DOCTYPE: the input is our own trusted manifest, but an XML
            // parser left at its permissive defaults is exactly the shape bandit/semgrep flag, and
            // the hardening costs nothing here.
            val factory =
                DocumentBuilderFactory.newInstance().apply {
                    setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
                    setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
                    isXIncludeAware = false
                    isExpandEntityReferences = false
                }
            document = factory.newDocumentBuilder().parse(manifestFile)
        }
    }

    /** Returns the first element named [tag] whose `android:name` is [name], or null. */
    private fun elementNamed(
        tag: String,
        name: String,
    ): Element? {
        val nodes = document.getElementsByTagName(tag)
        return (0 until nodes.length)
            .map { nodes.item(it) as Element }
            .firstOrNull { it.getAttribute("android:name") == name }
    }

    /**
     * Returns every `android:name` value declared by a `uses-permission` element in the parsed
     * manifest, in document order — the shared lookup each permission-focused test filters.
     */
    private fun permissionNames(): List<String> {
        val nodes = document.getElementsByTagName("uses-permission")
        return (0 until nodes.length).map { (nodes.item(it) as Element).getAttribute("android:name") }
    }

    @Test
    fun `declares camera and microphone permissions`() {
        val names = permissionNames()
        assertTrue(names.contains("android.permission.CAMERA"))
        assertTrue(names.contains("android.permission.RECORD_AUDIO"))
    }

    @Test
    fun `declares foreground service permissions for camera and microphone`() {
        val names = permissionNames()
        assertTrue(names.contains("android.permission.FOREGROUND_SERVICE"))
        assertTrue(names.contains("android.permission.FOREGROUND_SERVICE_CAMERA"))
        assertTrue(names.contains("android.permission.FOREGROUND_SERVICE_MICROPHONE"))
    }

    @Test
    fun `declares network, notification and wake lock permissions`() {
        val names = permissionNames()
        assertTrue(names.contains("android.permission.INTERNET"))
        assertTrue(names.contains("android.permission.POST_NOTIFICATIONS"))
        assertTrue(names.contains("android.permission.WAKE_LOCK"))
    }

    @Test
    fun `declares no USB permissions or features in M1`() {
        val names = permissionNames()
        assertFalse(names.any { it.contains("USB", ignoreCase = true) })
        val features = document.getElementsByTagName("uses-feature")
        val featureNames = (0 until features.length).map { (features.item(it) as Element).getAttribute("android:name") }
        assertFalse(featureNames.any { it.contains("usb", ignoreCase = true) })
    }

    @Test
    fun `declares StreamService as a non-exported camera and microphone foreground service`() {
        val streamService = elementNamed("service", ".pipeline.StreamService")
        requireNotNull(streamService) { "StreamService not declared in AndroidManifest.xml" }
        val serviceType = streamService.getAttribute("android:foregroundServiceType")
        assertTrue(serviceType.contains("camera"))
        assertTrue(serviceType.contains("microphone"))
        assertFalse(streamService.getAttribute("android:exported").toBoolean())
    }

    @Test
    fun `StreamService stops with the task so swiping the app away ends the stream`() {
        // A started foreground service survives task removal, so without this the stream keeps
        // running against the camera, mic and RTMP socket after a swipe-away, reachable only
        // through the notification's Stop action. Backs up StreamService.onTaskRemoved.
        val streamService = elementNamed("service", ".pipeline.StreamService")
        requireNotNull(streamService) { "StreamService not declared in AndroidManifest.xml" }
        assertTrue(streamService.getAttribute("android:stopWithTask").toBoolean())
    }

    @Test
    fun `declares a queries element for https VIEW so canLaunchUrl works on Android 11 and up`() {
        // canLaunchUrl resolves through queryIntentActivities, which package-visibility filtering
        // makes return false from API 30 unless the app declares matching <queries>. Without this
        // the update checker's "Open" action can never reach a browser on nearly the whole fleet.
        val queries = document.getElementsByTagName("queries")
        assertEquals(1, queries.length, "exactly one <queries> element expected")
        val intents = (queries.item(0) as Element).getElementsByTagName("intent")
        val httpsView =
            (0 until intents.length)
                .map { intents.item(it) as Element }
                .any { intent ->
                    val actions = intent.getElementsByTagName("action")
                    val data = intent.getElementsByTagName("data")
                    val viewAction =
                        (0 until actions.length).any {
                            (actions.item(it) as Element).getAttribute("android:name") == "android.intent.action.VIEW"
                        }
                    val httpsScheme =
                        (0 until data.length).any { (data.item(it) as Element).getAttribute("android:scheme") == "https" }
                    viewAction && httpsScheme
                }
        assertTrue(httpsView, "<queries> must declare an https VIEW intent")
    }

    @Test
    fun `disables Auto Backup so a restore cannot resurrect undecryptable secure storage`() {
        // flutter_secure_storage's blob is encrypted with a Keystore key that does not travel with
        // a backup, so a restored install would carry a payload it can never decrypt.
        val application = document.getElementsByTagName("application").item(0) as Element
        assertFalse(application.getAttribute("android:allowBackup").toBoolean())
    }

    @Test
    fun `requires a camera of any facing, not specifically a rear one`() {
        // The bare android.hardware.camera feature means a *rear-facing* camera and would hide
        // Gazer on Play from front-camera-only devices it streams from perfectly well.
        val features = document.getElementsByTagName("uses-feature")
        val names = (0 until features.length).map { (features.item(it) as Element).getAttribute("android:name") }
        assertTrue(names.contains("android.hardware.camera.any"))
        assertFalse(names.contains("android.hardware.camera"))
    }
}
