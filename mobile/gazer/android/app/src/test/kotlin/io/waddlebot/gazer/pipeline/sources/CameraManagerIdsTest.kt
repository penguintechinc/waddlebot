package io.waddlebot.gazer.pipeline.sources

import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * CameraManagerIds is the production [CameraIds] backed by the real [CameraManager] -
 * VideoSourceFactoryTest only ever exercises the fake implementation, so this covers the real
 * one directly with a mocked CameraManager/CameraCharacteristics (no hardware needed).
 */
class CameraManagerIdsTest {
    @Test
    fun `byFacing returns the id whose characteristics match the requested facing`() {
        val backCharacteristics = mockk<CameraCharacteristics>()
        every { backCharacteristics.get(CameraCharacteristics.LENS_FACING) } returns CameraCharacteristics.LENS_FACING_BACK
        val frontCharacteristics = mockk<CameraCharacteristics>()
        every { frontCharacteristics.get(CameraCharacteristics.LENS_FACING) } returns CameraCharacteristics.LENS_FACING_FRONT

        val cameraManager = mockk<CameraManager>()
        every { cameraManager.cameraIdList } returns arrayOf("0", "1")
        every { cameraManager.getCameraCharacteristics("0") } returns backCharacteristics
        every { cameraManager.getCameraCharacteristics("1") } returns frontCharacteristics

        val ids = CameraManagerIds(cameraManager)

        assertEquals("0", ids.byFacing(CameraCharacteristics.LENS_FACING_BACK))
        assertEquals("1", ids.byFacing(CameraCharacteristics.LENS_FACING_FRONT))
    }

    @Test
    fun `byFacing returns null when no camera matches the requested facing`() {
        val characteristics = mockk<CameraCharacteristics>()
        every { characteristics.get(CameraCharacteristics.LENS_FACING) } returns CameraCharacteristics.LENS_FACING_BACK

        val cameraManager = mockk<CameraManager>()
        every { cameraManager.cameraIdList } returns arrayOf("0")
        every { cameraManager.getCameraCharacteristics("0") } returns characteristics

        val ids = CameraManagerIds(cameraManager)

        assertNull(ids.byFacing(CameraCharacteristics.LENS_FACING_FRONT))
    }

    @Test
    fun `an unavailable camera service reports no camera rather than throwing to Dart`() {
        // This feeds listVideoDevices(), a non-suspend Pigeon method: an escaping
        // CameraAccessException (camera service down, or camera disabled by device policy) would
        // reach Dart as a PlatformException on a plain device-list query.
        val cameraManager = mockk<CameraManager>()
        every { cameraManager.cameraIdList } throws CameraAccessException(CameraAccessException.CAMERA_DISABLED)

        val ids = CameraManagerIds(cameraManager)

        // An escaping CameraAccessException fails this test on its own - that was the old behavior.
        assertNull(ids.byFacing(CameraCharacteristics.LENS_FACING_BACK))
    }

    @Test
    fun `a camera whose characteristics cannot be read is skipped rather than throwing`() {
        val cameraManager = mockk<CameraManager>()
        every { cameraManager.cameraIdList } returns arrayOf("0")
        every { cameraManager.getCameraCharacteristics("0") } throws CameraAccessException(CameraAccessException.CAMERA_ERROR)

        val ids = CameraManagerIds(cameraManager)

        // An escaping CameraAccessException fails this test on its own - that was the old behavior.
        assertNull(ids.byFacing(CameraCharacteristics.LENS_FACING_BACK))
    }
}
