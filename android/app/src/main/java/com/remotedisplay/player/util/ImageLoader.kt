package com.remotedisplay.player.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import java.io.File
import java.net.URL

/**
 * Safe bitmap loader. Reads dimensions first via inJustDecodeBounds, then decodes
 * with an inSampleSize that scales the image down to the device's screen resolution.
 * A 4K source image on a 1080p screen ends up as 1920x1080, not 3840x2160 — keeps
 * the bitmap under ~8 MB instead of ~33 MB.
 *
 * All exceptions, including OutOfMemoryError, return null so the caller can skip the
 * item rather than crashing the whole app.
 */
object ImageLoader {
    private const val TAG = "ImageLoader"

    fun screenWidth(ctx: Context): Int = ctx.resources.displayMetrics.widthPixels
    fun screenHeight(ctx: Context): Int = ctx.resources.displayMetrics.heightPixels

    fun decodeFile(file: File, maxW: Int, maxH: Int): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                Log.w(TAG, "Invalid image dimensions for ${file.name}")
                return null
            }
            val opts = BitmapFactory.Options().apply {
                inSampleSize = calcSampleSize(bounds.outWidth, bounds.outHeight, maxW, maxH)
            }
            BitmapFactory.decodeFile(file.absolutePath, opts)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM decoding ${file.name}: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to decode ${file.name}: ${e.message}")
            null
        }
    }

    fun decodeUrl(url: String, maxW: Int, maxH: Int): Bitmap? {
        return try {
            val bytes = URL(url).openConnection().apply {
                connectTimeout = 10_000
                readTimeout = 30_000
            }.getInputStream().use { it.readBytes() }
            decodeBytes(bytes, maxW, maxH)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM downloading $url: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to download $url: ${e.message}")
            null
        }
    }

    private fun decodeBytes(bytes: ByteArray, maxW: Int, maxH: Int): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            val opts = BitmapFactory.Options().apply {
                inSampleSize = calcSampleSize(bounds.outWidth, bounds.outHeight, maxW, maxH)
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM decoding ${bytes.size} bytes: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to decode ${bytes.size} bytes: ${e.message}")
            null
        }
    }

    private fun calcSampleSize(srcW: Int, srcH: Int, maxW: Int, maxH: Int): Int {
        if (maxW <= 0 || maxH <= 0) return 1
        var sample = 1
        while (srcW / sample > maxW || srcH / sample > maxH) sample *= 2
        return sample
    }
}
