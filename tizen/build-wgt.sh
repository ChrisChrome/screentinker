#!/bin/bash
# Build the ScreenTinker Tizen .wgt.
#  - If the Tizen CLI is on PATH, sign with a security profile (arg 1, default
#    "ScreenTinker"): produces a TV-installable signed .wgt.
#  - Otherwise, produce an UNSIGNED .wgt (plain zip) — fine for inspection / the
#    URL-Launcher path, but retail Samsung TVs need a signed package.
set -e
cd "$(dirname "$0")"
OUT="ScreenTinker.wgt"
FILES="config.xml index.html icon.png css js"
rm -f "$OUT"

if command -v tizen >/dev/null 2>&1; then
  PROFILE="${1:-ScreenTinker}"
  echo "Tizen CLI found — signing with profile '$PROFILE'…"
  tizen package -t wgt -s "$PROFILE" -- . -o .
  echo "Signed $OUT ready."
else
  echo "Tizen CLI not found — building UNSIGNED $OUT."
  zip -r -X "$OUT" $FILES -x '*.DS_Store' '_*' >/dev/null
  echo "Built $OUT ($(du -h "$OUT" | cut -f1), UNSIGNED — sign before installing on a retail TV)."
fi
