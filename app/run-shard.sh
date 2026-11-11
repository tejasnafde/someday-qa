#!/usr/bin/env bash
# Runs one QA shard (app/shards/<shard>/) on a GitHub runner
# (.github/workflows/qa.yml, jobs "android" and "ios"). Never run this on a
# laptop: it drives a simulator or an emulator.
#
# One Maestro session runs the shard's flows in order (its config.yaml), so
# the Maestro driver starts once. Steps that need a secret or a host command
# (a sign-in code, a fresh invite link, a share intent, closing Safari) go
# through the QA helper (app/helper.mjs), which this script starts on
# 127.0.0.1. A failed flow does not stop the next one.
#
# XFAIL: universal links (an invite link opens the app, not Safari) ship in
# iOS 1.23.1. For an older .app the invite-link-opens-app flows are XFAIL: a
# failure is reported and does not fail the run, and a pass is XPASS (the
# reason is stale). The flows that build on an opened link change with it
# (UL=false): sign-in expects the dashboard, not the invite circle, and the
# link-again-as-member flow is skipped. From 1.23.1 all are real checks. The
# version comes from the .app's Info.plist.
#
# Env: QA_PLATFORM (android|ios), QA_SHARD, QA_OUT, QA_RUN_ID; APK (android)
# or APP_DIR (ios); DEVICE (ios: the simulator UDID, booted or booting;
# android: the adb serial, default emulator-5554); the QA secrets
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, QA_EMAIL_A (the shared inviter,
# API only) and QA_EMAIL_B (the account this shard signs in).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QA="$ROOT/app"
PKG="app.someday.capture"
UNIVERSAL_LINKS_FROM="1.23.1"
LINK_FLOW="invite-link-opens-app"
NEEDS_UL="invite-again-member"
PORT="${QA_HELPER_PORT:-8765}"
mkdir -p "$QA_OUT"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || [ -z "${QA_EMAIL_A:-}" ] || [ -z "${QA_EMAIL_B:-}" ]; then
  echo "SKIPPED shard $QA_SHARD: QA secrets missing"
  exit 0
fi

# --- Device ------------------------------------------------------------------------
XFAIL_FLOWS=""
SKIPPED_FLOWS=""
UL=true
if [ "$QA_PLATFORM" = "android" ]; then
  DEVICE="${DEVICE:-emulator-5554}"
  adb -s "$DEVICE" wait-for-device
  # Let a cold boot settle (late system ANR dialogs), and keep error dialogs
  # from covering the app.
  adb -s "$DEVICE" shell settings put global hide_error_dialogs 1 || true
  adb -s "$DEVICE" shell input keyevent 82 || true
  echo "Android $(adb -s "$DEVICE" shell getprop ro.build.version.release) (API $(adb -s "$DEVICE" shell getprop ro.build.version.sdk))"
  # -g grants every runtime permission; the notification one is taken back,
  # so the app meets the real Android 13+ prompt.
  adb -s "$DEVICE" install -r -g "$APK" >/dev/null || adb -s "$DEVICE" install -r "$APK"
  adb -s "$DEVICE" shell pm revoke "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null || true
  adb -s "$DEVICE" shell pm clear-permission-flags "$PKG" android.permission.POST_NOTIFICATIONS user-set user-fixed 2>/dev/null || true
  adb -s "$DEVICE" shell dumpsys package "$PKG" | grep -m1 versionName || true
  # App links: Android checks /.well-known/assetlinks.json for each host in
  # the autoVerify filter. Ask again now, and wait for the answer.
  adb -s "$DEVICE" shell pm verify-app-links --re-verify "$PKG" || true
  for _ in $(seq 1 20); do
    adb -s "$DEVICE" shell pm get-app-links "$PKG" > "$QA_OUT/app-links.txt" 2>&1
    grep -q "someday.tn07.dev: verified" "$QA_OUT/app-links.txt" && break
    sleep 3
  done
  echo "App link state:"; cat "$QA_OUT/app-links.txt"
  shot() { adb -s "$DEVICE" exec-out screencap -p > "$QA_OUT/$1.png" 2>/dev/null || true; }
else
  APP="$(find "$APP_DIR" -maxdepth 3 -name '*.app' -type d | head -n 1)"
  [ -n "$APP" ] || { echo "No .app under $APP_DIR"; exit 1; }
  APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Info.plist" 2>/dev/null || echo 0)"
  echo "App: $APP (version $APP_VERSION)"
  if ! python3 -c 'import sys; v=lambda s: tuple(int(x) for x in s.split(".") if x.isdigit()); sys.exit(0 if v(sys.argv[1]) >= v(sys.argv[2]) else 1)' "$APP_VERSION" "$UNIVERSAL_LINKS_FROM"; then
    UL=false
    XFAIL_FLOWS="$LINK_FLOW"
    SKIPPED_FLOWS="$NEEDS_UL"
    echo "XFAIL for this run: $XFAIL_FLOWS (app $APP_VERSION has no universal links; they ship in $UNIVERSAL_LINKS_FROM)"
  fi
  xcrun simctl bootstatus "$DEVICE" -b >/dev/null
  echo "Simulator: $(xcrun simctl list devices | grep "$DEVICE")"
  xcrun simctl install "$DEVICE" "$APP"
  # One photo in the library for the picker (a plain generated PNG).
  python3 - "$QA_OUT/qa-photo.png" <<'PY'
import struct, sys, zlib
w, h = 64, 64
raw = b"".join(b"\x00" + bytes([90, 75, 140]) * w for _ in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
PY
  xcrun simctl addmedia "$DEVICE" "$QA_OUT/qa-photo.png"
  shot() { xcrun simctl io "$DEVICE" screenshot "$QA_OUT/$1.png" >/dev/null 2>&1 || true; }
fi
export DEVICE
if [ "$UL" = "true" ]; then
  LINK_EXPECT=".*QA $QA_RUN_ID $QA_SHARD link.*"
else
  LINK_EXPECT=".*(New Circle|Who do you make plans with).*"
fi

# --- Helper ------------------------------------------------------------------------
QA_HELPER_LOG="$QA_OUT/helper.log" QA_HELPER_PORT="$PORT" node "$QA/helper.mjs" &
HELPER_PID=$!
trap 'kill $HELPER_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null || { echo "The QA helper did not start"; cat "$QA_OUT/helper.log"; exit 1; }

# --- Flows -------------------------------------------------------------------------
maestro --version
maestro --device "$DEVICE" test \
  --format junit --output "$QA_OUT/report.xml" \
  --test-output-dir "$QA_OUT/maestro" \
  -e "EMAIL=$QA_EMAIL_B" -e "RUN=$QA_RUN_ID" -e "SHARD=$QA_SHARD" -e "HELPER_PORT=$PORT" \
  -e "UL=$UL" -e "LINK_EXPECT=$LINK_EXPECT" \
  "$QA/shards/$QA_SHARD" 2>&1 | tee "$QA_OUT/maestro.log"
shot "zz-last-screen"
echo "--- helper log"; cat "$QA_OUT/helper.log"

# --- Summary -----------------------------------------------------------------------
python3 - "$QA_OUT/report.xml" "$XFAIL_FLOWS" "$QA_OUT/summary.txt" "$SKIPPED_FLOWS" <<'PY'
import re, sys, xml.etree.ElementTree as ET
report, xfail, out, skipped = sys.argv[1], set(sys.argv[2].split()), sys.argv[3], set(sys.argv[4].split())
try:
    cases = ET.parse(report).getroot().iter("testcase")
except Exception as e:
    print(f"FAILED: no Maestro report ({e})"); open(out, "w").write("FAILED: no report\n"); sys.exit(1)
groups = {"PASS": [], "XFAIL": [], "XPASS": [], "FAIL": [], "SKIPPED": []}
for c in cases:
    name = c.get("name") or c.get("id") or "?"
    bare = re.sub(r"^\d+-", "", name)
    failed = c.find("failure") is not None or c.find("error") is not None
    if bare in skipped and not failed:
        groups["SKIPPED"].append(name)
    elif bare in xfail:
        groups["XFAIL" if failed else "XPASS"].append(name)
    else:
        groups["FAIL" if failed else "PASS"].append(name)
lines = [f"{k} ({len(v)}): {' '.join(v)}" for k, v in groups.items()]
text = "\n".join(lines)
print(text); open(out, "w").write(text + "\n")
sys.exit(1 if groups["FAIL"] or not (groups["PASS"] or groups["XFAIL"]) else 0)
PY
status=$?
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### $QA_SHARD"; echo '```'; cat "$QA_OUT/summary.txt"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
exit $status
