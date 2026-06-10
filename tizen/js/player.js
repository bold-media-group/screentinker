/* PlaylistPlayer — fullscreen single-zone renderer for the Tizen player.
 * Mirrors the Android player's content rules:
 *   image        -> shown for duration_sec (min 3s), then advance
 *   video        -> plays to end then advance; single item loops
 *   video/youtube-> iframe embed; single item loops, multi advances after duration
 *   remote_url   -> same as image/video but src = remote_url
 *   widget       -> iframe of {server}/api/widgets/{id}/render for duration_sec
 * Content file URL: {server}/api/content/{content_id}/file  (public)
 */
function PlaylistPlayer(stageEl, getBase) {
  this.stage = stageEl;
  this.getBase = getBase;
  this.items = [];
  this.index = 0;
  this.timer = null;
  this.sig = '';
  this.DEFAULT_DURATION = 10;
  this.MIN_DURATION = 3;
}

PlaylistPlayer.prototype.load = function (assignments) {
  var items = (assignments || []).filter(function (a) {
    return a && (a.content_id || a.widget_id || a.remote_url);
  });
  // Stable order
  items.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });

  var sig = JSON.stringify(items.map(function (a) {
    return [a.content_id, a.widget_id, a.remote_url, a.duration_sec, a.mime_type];
  }));
  if (sig === this.sig && this.items.length) return; // unchanged, keep playing

  this.sig = sig;
  this.items = items;
  this.index = 0;
  this.playCurrent();
};

PlaylistPlayer.prototype.stop = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  this.clearStage();
};

PlaylistPlayer.prototype.clearStage = function () {
  // Pause any video before removing so audio doesn't linger.
  var v = this.stage.querySelector('video');
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
  this.stage.innerHTML = '';
};

PlaylistPlayer.prototype.idle = function () {
  this.clearStage();
  this.stage.innerHTML =
    '<div class="card" style="position:relative"><h1>ScreenTinker</h1>' +
    '<p class="sub">No content assigned yet</p></div>';
};

PlaylistPlayer.prototype.durationMs = function (item) {
  var d = item.duration_sec || this.DEFAULT_DURATION;
  if (d < this.MIN_DURATION) d = this.MIN_DURATION;
  return d * 1000;
};

PlaylistPlayer.prototype.contentUrl = function (item) {
  if (item.remote_url) return item.remote_url;
  if (item.content_id) return this.getBase() + '/api/content/' + item.content_id + '/file';
  return null;
};

PlaylistPlayer.prototype.advance = function () {
  if (!this.items.length) return;
  this.index = (this.index + 1) % this.items.length;
  this.playCurrent();
};

PlaylistPlayer.prototype.schedule = function (ms) {
  var self = this;
  if (this.timer) clearTimeout(this.timer);
  this.timer = setTimeout(function () { self.advance(); }, ms);
};

PlaylistPlayer.prototype.playCurrent = function () {
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  if (!this.items.length) { this.idle(); return; }

  var item = this.items[this.index];
  var single = this.items.length === 1;
  var mime = item.mime_type || '';
  this.clearStage();

  try {
    if (mime === 'video/youtube') return this.renderYouTube(item, single);
    if (item.widget_id && !item.content_id) return this.renderWidget(item, single);
    if (mime.indexOf('video/') === 0) return this.renderVideo(item, single);
    if (mime.indexOf('image/') === 0) return this.renderImage(item, single);
    // Fallback: a remote_url with unknown mime -> try iframe
    if (item.remote_url) return this.renderFrame(item.remote_url, single ? 0 : this.durationMs(item));
  } catch (e) {
    this.skipSoon();
    return;
  }
  // Unknown item -> skip
  this.skipSoon();
};

// Give a broken item ~2s then move on so the loop never wedges.
PlaylistPlayer.prototype.skipSoon = function () {
  if (this.items.length > 1) this.schedule(2000);
};

PlaylistPlayer.prototype.fit = function (el, item) {
  // assignment may carry a fit hint; default cover (matches Android default)
  var f = (item.fit || item.scale || 'cover').toLowerCase();
  if (f === 'contain' || f === 'fit') el.className = 'contain';
  else if (f === 'fill' || f === 'stretch') el.className = 'fill';
  else el.className = 'cover';
};

PlaylistPlayer.prototype.renderImage = function (item, single) {
  var self = this;
  var img = document.createElement('img');
  this.fit(img, item);
  img.onerror = function () { self.skipSoon(); };
  img.src = this.contentUrl(item);
  this.stage.appendChild(img);
  if (!single) this.schedule(this.durationMs(item));
};

PlaylistPlayer.prototype.renderVideo = function (item, single) {
  var self = this;
  var v = document.createElement('video');
  this.fit(v, item);
  v.autoplay = true; v.muted = true; v.setAttribute('playsinline', '');
  v.loop = single; // single item loops; multi advances on end
  v.onended = function () { if (!single) self.advance(); };
  v.onerror = function () { self.skipSoon(); };
  v.src = this.contentUrl(item);
  this.stage.appendChild(v);
  var p = v.play(); if (p && p.catch) p.catch(function () {});
  // Safety net: if 'ended' never fires (rare), advance after the known
  // content duration (or the assignment duration) + a buffer.
  if (!single) {
    var secs = item.content_duration || item.duration_sec || this.DEFAULT_DURATION;
    this.schedule((secs + 5) * 1000);
  }
};

PlaylistPlayer.prototype.renderYouTube = function (item, single) {
  var id = this.youtubeId(item.remote_url);
  if (!id) { this.skipSoon(); return; }
  var src = 'https://www.youtube.com/embed/' + id +
    '?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&loop=1&playlist=' + id + '&playsinline=1';
  this.renderFrame(src, single ? 0 : this.durationMs(item), 'autoplay; encrypted-media');
};

PlaylistPlayer.prototype.renderWidget = function (item, single) {
  var src = this.getBase() + '/api/widgets/' + item.widget_id + '/render';
  this.renderFrame(src, single ? 0 : this.durationMs(item));
};

PlaylistPlayer.prototype.renderFrame = function (src, advanceMs, allow) {
  var f = document.createElement('iframe');
  f.setAttribute('frameborder', '0');
  f.setAttribute('allowfullscreen', '');
  if (allow) f.setAttribute('allow', allow);
  f.src = src;
  this.stage.appendChild(f);
  if (advanceMs > 0) this.schedule(advanceMs);
};

PlaylistPlayer.prototype.youtubeId = function (url) {
  if (!url) return null;
  var m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url; // bare id
  return null;
};
