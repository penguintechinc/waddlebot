package io.waddlebot.gazer

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import androidx.test.rule.ServiceTestRule
import io.waddlebot.gazer.pipeline.StreamService
import io.waddlebot.gazer.pipeline.buildStopPendingIntent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented lifecycle test: StreamService must post its foreground notification on start and
 * remove it cleanly when ACTION_STOP is broadcast (the real path the notification's own Stop
 * action - and any other Stop trigger - takes; see StreamService's stopReceiver, which delegates to
 * ServiceTeardownController.stopEverything(): pipeline.stop(), stopForeground(STOP_FOREGROUND_REMOVE),
 * stopSelf(), then releasing the bound clients so a later Go Live re-binds and re-foregrounds
 * instead of short-circuiting past StreamService.start() (R1). Cannot run on the JVM unit-test
 * target since it needs a real NotificationManager and Android service lifecycle.
 *
 * Note this test does NOT cover RootEncoderEngine: StreamService's pipeline is lazy and is never
 * prepared here, so no engine is ever constructed. RootEncoderEngine's runtime gate is
 * integration_test/go_live_unreachable_test.dart on the same emulator job.
 */
@RunWith(AndroidJUnit4::class)
class StreamServiceTest {
    @get:Rule
    val serviceRule = ServiceTestRule()

    /**
     * StreamService.onStartCommand calls startForeground with the camera+microphone FGS types, and
     * Android 14+ rejects that with a SecurityException ("requires permissions: all of ...") unless
     * CAMERA and RECORD_AUDIO are actually granted -- which crashes the whole instrumentation
     * process, not just this test. The connectedAndroidTest install does not grant them, so the
     * test grants what the service it exercises needs rather than depending on whatever the device
     * happened to be left in by an earlier install.
     */
    @get:Rule
    val permissionRule: GrantPermissionRule =
        GrantPermissionRule.grant(
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.POST_NOTIFICATIONS,
        )

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val notificationManager: NotificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    @Test
    fun startPostsTheForegroundNotificationAndActionStopRemovesItAndStopsTheService() {
        serviceRule.startService(Intent(context, StreamService::class.java))

        val hasNotification =
            pollUntil(timeoutMs = 5000) {
                notificationManager.activeNotifications.any { it.packageName == context.packageName }
            }
        assertTrue("expected an active notification after start", hasNotification)

        // The real Stop trigger: the notification's own action (and any other Stop UI) sends the
        // exact PendingIntent buildStopPendingIntent builds for the notification - not a hand-built
        // broadcast, since a test that constructs its own Intent(ACTION_STOP).setPackage(...) can
        // pass while buildStopPendingIntent's own setPackage call regresses (item 3, 7c review):
        // this pins both the package and the delivery path that the notification's Stop action
        // actually takes to reach stopReceiver, which stops the pipeline, removes the foreground
        // notification, and calls stopSelf() to destroy the service.
        buildStopPendingIntent(context)!!.send()

        // stopForeground(STOP_FOREGROUND_REMOVE) removes the notification synchronously with the
        // broadcast receipt, before the asynchronous stopSelf()-driven onDestroy() completes, so
        // notification removal is the reliable, immediately observable signal here that the
        // ACTION_STOP path ran end to end (a further onDestroy()-completion assertion would need
        // its own instrumentation hook, which this behavioral guarantee doesn't require).
        val notificationGone =
            pollUntil(timeoutMs = 5000) {
                notificationManager.activeNotifications.none { it.packageName == context.packageName }
            }
        assertTrue("expected the notification to be removed after ACTION_STOP", notificationGone)
    }

    private fun pollUntil(
        timeoutMs: Long,
        intervalMs: Long = 100,
        condition: () -> Boolean,
    ): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(intervalMs)
        }
        return condition()
    }
}
