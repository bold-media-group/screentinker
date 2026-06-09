package com.remotedisplay.player.player

import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.remotedisplay.player.util.ImageLoader
import java.io.File

class MediaPlayerManager(
    private val context: Context,
    private val playerView: PlayerView,
    private val imageView: ImageView,
    private val youtubeWebView: WebView? = null,
    private val onVideoComplete: () -> Unit,
    private val onImageError: (() -> Unit)? = null
) {
    private var exoPlayer: ExoPlayer? = null
    private var currentType: MediaType = MediaType.NONE

    enum class MediaType { NONE, VIDEO, IMAGE, YOUTUBE, WIDGET }

    init {
        setupExoPlayer()
    }

    private fun setupExoPlayer() {
        exoPlayer = ExoPlayer.Builder(context).build().also { player ->
            playerView.player = player
            player.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(playbackState: Int) {
                    if (playbackState == Player.STATE_ENDED) {
                        onVideoComplete()
                    }
                }
            })
        }
    }

    fun playYoutube(embedUrl: String, durationSec: Int = 0) {
        Log.i("MediaPlayerManager", "Playing YouTube: $embedUrl")
        currentType = MediaType.YOUTUBE

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.VISIBLE

        exoPlayer?.stop()

        youtubeWebView?.apply {
            com.remotedisplay.player.util.WebViewSupport.configure(this, "YouTube")
            setBackgroundColor(android.graphics.Color.BLACK)
            // Load via an embed wrapper with a valid youtube.com origin (Error 153 fix).
            val html = com.remotedisplay.player.util.WebViewSupport.youtubeEmbedHtml(embedUrl)
            if (html != null) loadDataWithBaseURL(com.remotedisplay.player.util.WebViewSupport.EMBED_BASE, html, "text/html", "UTF-8", null)
            else loadUrl(embedUrl)
        }
    }

    // Fullscreen widget render (single-zone / "fullscreen" layouts). Reuses the
    // full-screen WebView; ZoneManager handles widgets in multi-zone layouts.
    fun showWidget(url: String) {
        Log.i("MediaPlayerManager", "Showing widget: $url")
        currentType = MediaType.WIDGET

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.VISIBLE

        exoPlayer?.stop()

        youtubeWebView?.apply {
            com.remotedisplay.player.util.WebViewSupport.configure(this, "Widget")
            loadUrl(url)
        }
    }

    fun playVideoFromUrl(url: String, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Streaming video from URL: $url (muted=$muted)")
        currentType = MediaType.VIDEO

        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.apply {
            volume = if (muted) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            prepare()
            playWhenReady = true
        }
    }

    fun showImageFromUrl(url: String) {
        Log.i("MediaPlayerManager", "Loading remote image: $url")
        currentType = MediaType.IMAGE

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.VISIBLE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.stop()

        Thread {
            val bitmap = ImageLoader.decodeUrl(url, ImageLoader.screenWidth(context), ImageLoader.screenHeight(context))
            if (bitmap != null) {
                imageView.post {
                    try { imageView.setImageBitmap(bitmap) }
                    catch (e: Throwable) { Log.e("MediaPlayerManager", "setImageBitmap failed: ${e.message}"); onImageError?.invoke() }
                }
            } else {
                Log.w("MediaPlayerManager", "Skipping unloadable remote image: $url")
                imageView.post { onImageError?.invoke() }
            }
        }.start()
    }

    fun playVideo(file: File, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Playing video: ${file.absolutePath} (muted=$muted)")
        currentType = MediaType.VIDEO

        // Show player, hide image
        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.apply {
            volume = if (muted) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            prepare()
            playWhenReady = true
        }
    }

    fun showImage(file: File) {
        Log.i("MediaPlayerManager", "Showing image: ${file.absolutePath}")
        currentType = MediaType.IMAGE

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.VISIBLE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.stop()

        val bitmap = ImageLoader.decodeFile(file, ImageLoader.screenWidth(context), ImageLoader.screenHeight(context))
        if (bitmap == null) {
            Log.w("MediaPlayerManager", "Skipping unloadable image: ${file.name}")
            onImageError?.invoke()
            return
        }
        try {
            imageView.setImageBitmap(bitmap)
        } catch (e: Throwable) {
            Log.e("MediaPlayerManager", "setImageBitmap failed: ${e.message}")
            onImageError?.invoke()
        }
    }

    fun stop() {
        exoPlayer?.stop()
        imageView.setImageBitmap(null)
        youtubeWebView?.loadUrl("about:blank")
        youtubeWebView?.visibility = android.view.View.GONE
        currentType = MediaType.NONE
    }

    fun release() {
        exoPlayer?.release()
        exoPlayer = null
    }

    fun isPlayingVideo(): Boolean = currentType == MediaType.VIDEO && (exoPlayer?.isPlaying == true)
}
