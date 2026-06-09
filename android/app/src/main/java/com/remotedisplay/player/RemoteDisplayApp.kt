package com.remotedisplay.player

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class RemoteDisplayApp : Application() {

    companion object {
        const val CHANNEL_ID = "remote_display_service"
        const val CHANNEL_NAME = "ScreenTinker Service"
        // Separate HIGH-importance channel for the boot full-screen-intent launch.
        // A full-screen intent is only honored from a high-importance channel.
        const val BOOT_CHANNEL_ID = "remote_display_boot"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                    description = "ScreenTinker background service"
                    setShowBadge(false)
                }
            )
            manager.createNotificationChannel(
                NotificationChannel(BOOT_CHANNEL_ID, "ScreenTinker Startup", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Launches the display on boot"
                    setShowBadge(false)
                }
            )
        }
    }
}
