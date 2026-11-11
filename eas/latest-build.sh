#!/usr/bin/env bash
# Finds the newest finished EAS build of Someday (@tejasnafde/someday) that QA
# can install, and never starts a build.
#   ios:     the newest iOS simulator build (profile ios-sim).
#   android: the newest APK, profile qa-android first, else any APK profile.
#
# Usage: bash eas/latest-build.sh <ios|android>
# Needs EXPO_TOKEN. Writes found=true|false, id, version and profile to
# $GITHUB_OUTPUT. The download URL goes to $RUNNER_TEMP/eas-build-url, not to
# the log: this repository and its logs are public.
set -uo pipefail
platform="$1"
here="$(cd "$(dirname "$0")" && pwd)"
out="${GITHUB_OUTPUT:-/dev/stdout}"
tmp="${RUNNER_TEMP:-/tmp}"
EAS_CLI_VERSION="${EAS_CLI_VERSION:-27.6.0}"

if [ -z "${EXPO_TOKEN:-}" ]; then
  echo "::error::EXPO_TOKEN is not set, so the EAS builds cannot be listed."
  echo "found=false" >> "$out"
  exit 1
fi

args=(build:list --platform "$platform" --status finished --limit 50 --json --non-interactive)
[ "$platform" = "ios" ] && args+=(--simulator)
if ! (cd "$here" && npx -y "eas-cli@$EAS_CLI_VERSION" "${args[@]}") > "$tmp/eas-builds.json" 2> "$tmp/eas-builds.err"; then
  echo "::error::eas build:list failed:"
  tail -n 5 "$tmp/eas-builds.err"
  echo "found=false" >> "$out"
  exit 1
fi

if [ "$platform" = "ios" ]; then
  pick='[.[] | select(.isForIosSimulator == true and .artifacts.buildUrl != null)][0] // empty'
else
  apk='select(.artifacts.buildUrl != null and ((.artifacts.buildUrl | split("?")[0]) | endswith(".apk")))'
  pick="([.[] | $apk | select(.buildProfile == \"qa-android\")][0]) // ([.[] | $apk][0]) // empty"
fi
build="$(jq -c "$pick" "$tmp/eas-builds.json")"
if [ -z "$build" ]; then
  if [ "$platform" = "ios" ]; then
    echo "::error::No finished EAS iOS simulator build. Build one in the Someday repo: eas build --platform ios --profile ios-sim"
  else
    echo "::error::No finished EAS APK build. Build one in the Someday repo: eas build --platform android --profile qa-android"
  fi
  echo "found=false" >> "$out"
  exit 1
fi

id="$(jq -r '.id' <<<"$build")"
version="$(jq -r '.appVersion' <<<"$build")"
profile="$(jq -r '.buildProfile' <<<"$build")"
jq -r '.artifacts.buildUrl' <<<"$build" > "$tmp/eas-build-url"
echo "Newest $platform build for QA: $id (version $version, profile $profile)"
if [ "$platform" = "android" ] && [ "$profile" != "qa-android" ]; then
  echo "::warning::No finished qa-android build on EAS; testing the $profile APK $version. Build one: eas build --platform android --profile qa-android"
fi
{ echo "found=true"; echo "id=$id"; echo "version=$version"; echo "profile=$profile"; } >> "$out"
