package com.remotedisplay.player.util

import android.util.Log

/**
 * Lightweight player debug logger. Always writes to logcat; when remote debug is
 * enabled (toggled from the dashboard device-detail screen via a `set_debug`
 * command), it ALSO streams the line to the server over the device socket so it
 * can be watched live without adb. Off by default; no network when disabled.
 */
object DebugLog {
    @Volatile var enabled = false
    // Set by WebSocketService: (tag, level, message) -> emit over the device socket.
    @Volatile var sink: ((String, String, String) -> Unit)? = null

    fun d(tag: String, msg: String) { Log.d(tag, msg); send(tag, "d", msg) }
    fun i(tag: String, msg: String) { Log.i(tag, msg); send(tag, "i", msg) }
    fun w(tag: String, msg: String) { Log.w(tag, msg); send(tag, "w", msg) }
    fun e(tag: String, msg: String) { Log.e(tag, msg); send(tag, "e", msg) }

    private fun send(tag: String, level: String, msg: String) {
        if (!enabled) return
        try { sink?.invoke(tag, level, msg) } catch (_: Throwable) {}
    }
}
