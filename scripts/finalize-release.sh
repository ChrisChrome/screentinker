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
# NOTE: `tar` archives DOTFILES too, so anything secret sitting under server/ ships
# unless it is excluded by name. server/.env (Graph credentials) is gitignored, which
# is precisely why it never showed up in a diff - the exclude list is the only thing
# standing between it and a public release asset. Keep .env* and the local tooling
# configs here, and see the audit gate below, which is the real backstop.
# Exclude EVERY .env* / key-shaped file, then explicitly re-add the single legitimate
# one (.env.example, the config template self-hosters need). Doing it in that order
# means a new secret file is excluded by default rather than shipped by default - the
# exclusion is broad and the allowance is a named exception, not a glob that has to be
# gotten exactly right.
TMPTAR="${OUT%.gz}"
tar cf "$TMPTAR" \
  --exclude='node_modules' --exclude='.git' --exclude='.github' \
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db.*' \
  --exclude='server/uploads' --exclude='server/certs' --exclude='server/test' \
  --exclude='.env*' --exclude='*/.env*' \
  --exclude='.mcp.json' --exclude='*/.mcp.json' \
  --exclude='*.jks' --exclude='*.keystore' --exclude='*.pem' --exclude='*.key' \
  --exclude='.jwt_secret' --exclude='*/.jwt_secret' \
  server frontend scripts VERSION README.md LICENSE \
  ScreenTinker.apk ScreenTinker.wgt
tar rf "$TMPTAR" .env.example      # the one .env* that is meant to ship
gzip -f "$TMPTAR"                  # -> $OUT

# Secret gate. The exclude list above fails OPEN - a new secret file added under
# server/ ships unless someone remembers to add it. This gate fails CLOSED: it
# inspects what is actually IN the archive and refuses to upload if anything
# credential-shaped made it in. .env.example is deliberately shipped and allowed.
echo "==> Auditing $OUT for credential-shaped files"
# Match broadly, then subtract the single documented exception. Anything new that looks
# like a credential is caught by default; only .env.example is allowed through.
BAD="$(tar tzf "$OUT" \
  | grep -E '(^|/)(\.env|\.env\..*|\.mcp\.json|\.jwt_secret)$|\.(jks|keystore|pem|key|p12|pfx)$' \
  | grep -vE '(^|/)\.env\.example$' || true)"
if [ -n "$BAD" ]; then
  echo "ERROR: refusing to upload - the archive contains credential-shaped files:" >&2
  printf '  %s\n' $BAD >&2
  echo "       Add an --exclude for each, then re-run." >&2
  exit 1
fi
# The template MUST be present - its absence is a silent regression for self-hosters.
if ! tar tzf "$OUT" | grep -qx '.env.example'; then
  echo "ERROR: .env.example is missing from the archive (over-broad exclude?)." >&2
  exit 1
fi
echo "    clean ($(tar tzf "$OUT" | wc -l) files, .env.example present)"

echo "==> Uploading APK + complete tarball to $TAG"
gh release upload "$TAG" "$OUT" ScreenTinker.apk --clobber

echo "==> Done: $TAG now carries the standalone APK and a tarball bundling apk + wgt."
