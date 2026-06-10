#!/bin/bash
# Finalize a release with the artifacts that need the LOCAL signing keystore
# (which never goes into CI). After the release workflow has published the tag's
# GitHub Release (source tarball + unsigned .wgt + docker image), run this to:
#   1. build the SIGNED Android APK locally,
#   2. pull the CI-built unsigned .wgt back down from the release,
#   3. assemble a COMPLETE source tarball that bundles BOTH binaries
#      (extract it and ScreenTinker.apk sits at the root, ready for /download/apk),
#   4. upload the APK + the complete tarball to the release (replacing the
#      source-only tarball CI uploaded).
#
#   KEYSTORE_PASSWORD=... KEY_PASSWORD=... scripts/finalize-release.sh
#
# Requires: Android SDK + the release keystore (android/release-key.jks), the
# Tizen .wgt already on the release, and an authenticated gh CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(cat VERSION)"
TAG="v$VERSION"
: "${KEYSTORE_PASSWORD:?set KEYSTORE_PASSWORD}"
: "${KEY_PASSWORD:?set KEY_PASSWORD}"

cleanup() { rm -f ScreenTinker.apk ScreenTinker.wgt "screentinker-$VERSION.tar.gz"; }
trap cleanup EXIT

echo "==> Building signed APK $VERSION"
( cd android && KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" KEY_PASSWORD="$KEY_PASSWORD" ./gradlew assembleRelease )
cp android/app/build/outputs/apk/release/app-release.apk ScreenTinker.apk

echo "==> Pulling the CI-built unsigned .wgt from release $TAG"
gh release download "$TAG" -p ScreenTinker.wgt --clobber

echo "==> Assembling complete tarball (source + apk + wgt)"
OUT="screentinker-$VERSION.tar.gz"
tar czf "$OUT" \
  --exclude='node_modules' --exclude='.git' --exclude='.github' \
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db.*' \
  --exclude='server/uploads' --exclude='server/certs' --exclude='server/test' \
  server frontend scripts VERSION README.md LICENSE .env.example \
  ScreenTinker.apk ScreenTinker.wgt

echo "==> Uploading APK + complete tarball to $TAG"
gh release upload "$TAG" "$OUT" ScreenTinker.apk --clobber

echo "==> Done: $TAG now carries the standalone APK and a tarball bundling apk + wgt."
