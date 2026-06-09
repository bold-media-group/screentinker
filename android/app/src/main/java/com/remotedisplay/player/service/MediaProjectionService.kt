package com.remotedisplay.player.service

import android.app.Activity
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.remotedisplay.player.RemoteDisplayApp

/**
 * #5: Foreground service that owns the MediaProjection FGS type for system-wide
 * screen capture (the `enable_system_capture` command).
 *
 * Android 14+ requires an FGS of type `mediaProjection` to be running - started
 * AFTER the user grants consent - before MediaProjectionManager.getMediaProjection()
 * may be called. An Activity can't enter that foreground state, so the consent
 * Activity hands the result here. Kept separate from WebSocketService so the
 * always-on service never claims the mediaProjection type at boot.
 */
class MediaProjectionService : Service() {

    companion object {
        private const val TAG = "MediaProjectionSvc"
        private const val NOTIF_ID = 2
        private const val EXTRA_RESULT_CODE = "result_code"
        private const val EXTRA_RESULT_DATA = "result_data"

        /** Start the projection FGS with the user's consent result. */
        fun start(context: Context, resultCode: Int, data: Intent) {
            val intent = Intent(context, MediaProjectionService::class.java).apply {
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MediaProjectionService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Enter the foreground with the mediaProjection type FIRST (required on
        // Android 14+ before getMediaProjection()).
        startForegroundCompat()

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            ?: Activity.RESULT_CANCELED
        @Suppress("DEPRECATION")
        val data: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }

        if (resultCode != Activity.RESULT_OK || data == null) {
            Log.e(TAG, "Missing/invalid projection consent; stopping service")
            stopSelf()
            return START_NOT_STICKY
        }

        return try {
            ScreenCaptureService.startProjection(this, resultCode, data)
            START_STICKY
        } catch (e: Throwable) {
            Log.e(TAG, "startProjection failed: ${e.message}", e)
            stopSelf()
            START_NOT_STICKY
        }
    }

    private fun startForegroundCompat() {
        val notif = NotificationCompat.Builder(this, RemoteDisplayApp.CHANNEL_ID)
            .setContentTitle("ScreenTinker")
            .setContentText("Screen capture active")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    override fun onDestroy() {
        // Release the projection when the service goes away.
        try { ScreenCaptureService.stop() } catch (_: Throwable) {}
        super.onDestroy()
    }
}
