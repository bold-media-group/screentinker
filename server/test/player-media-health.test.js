'use strict';

// #146 web-player fix — the no-change-refresh branch-selection decision. This is the unit
// the refresh handler consults to decide whether to re-attach the media surface. It is the
// smallest testable piece of the "no new content lost the video but not the audio" fix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { needsReattach } = require('../lib/player-media-health');

const video = (o) => ({ isPlaying: true, hasCurrentItem: true, itemKind: 'video', videoEl: o, surfaceAttached: true });

test('healthy attached+live video on a no-change refresh -> NO re-attach (no flicker)', () => {
  assert.equal(needsReattach(video({ attached: true, ended: false, errored: false })), false);
});

test('THE BUG: a detached-but-playing <video> (audio persists, surface gone) -> re-attach', () => {
  assert.equal(needsReattach(video({ attached: false, ended: false, errored: false })), true);
});

test('video element gone entirely -> re-attach', () => {
  assert.equal(needsReattach({ isPlaying: true, hasCurrentItem: true, itemKind: 'video', videoEl: null }), true);
});

test('ended or errored video -> re-attach', () => {
  assert.equal(needsReattach(video({ attached: true, ended: true, errored: false })), true);
  assert.equal(needsReattach(video({ attached: true, ended: false, errored: true })), true);
});

test('idle / no current item -> never re-attach (leave the waiting screen)', () => {
  assert.equal(needsReattach({ isPlaying: false, hasCurrentItem: true, itemKind: 'video', videoEl: null }), false);
  assert.equal(needsReattach({ isPlaying: true, hasCurrentItem: false, itemKind: 'video', videoEl: null }), false);
  assert.equal(needsReattach(undefined), false);
});

test('non-video surface (image/youtube/widget): re-attach only when the surface is missing', () => {
  const base = { isPlaying: true, hasCurrentItem: true };
  assert.equal(needsReattach({ ...base, itemKind: 'image', surfaceAttached: true }), false);
  assert.equal(needsReattach({ ...base, itemKind: 'image', surfaceAttached: false }), true);
  assert.equal(needsReattach({ ...base, itemKind: 'youtube', surfaceAttached: false }), true);
  assert.equal(needsReattach({ ...base, itemKind: 'widget', surfaceAttached: true }), false);
});
