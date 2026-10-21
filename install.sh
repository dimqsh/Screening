#!/bin/bash
# Installs or updates Screening on a Mac, Apple silicon or Intel:
#   curl -fsSL https://raw.githubusercontent.com/dimqsh/Screening/main/install.sh | bash
set -euo pipefail

REPO="dimqsh/Screening"
RELEASES="https://github.com/$REPO/releases"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS. On Windows, run the .exe from $RELEASES"
  exit 1
fi
# A shell under Rosetta reports x86_64 on Apple silicon; ask the hardware.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
else
  arch=x64
fi

echo "Finding the newest Screening for $arch…"
url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=20" |
  grep -o "\"browser_download_url\": *\"[^\"]*mac-$arch\\.dmg\"" |
  head -n 1 | sed -E 's/.*"(https[^"]+)"$/\1/')
if [ -z "$url" ]; then
  echo "No Mac download found. See $RELEASES"
  exit 1
fi

work=$(mktemp -d)
mount="$work/volume"
cleanup() {
  hdiutil detach "$mount" -quiet 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "Downloading $(basename "$url")…"
curl -fL --progress-bar -o "$work/Screening.dmg" "$url"
hdiutil attach "$work/Screening.dmg" -nobrowse -readonly -quiet -mountpoint "$mount"

# An open copy is closed first so the new one can replace it.
if pgrep -xq Screening; then
  osascript -e 'quit app "Screening"' >/dev/null 2>&1 || true
  sleep 2
  pkill -x Screening 2>/dev/null || true
fi

dest="/Applications"
[ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
rm -rf "$dest/Screening.app"
ditto "$mount/Screening.app" "$dest/Screening.app"
# The app is not notarized, so macOS would otherwise refuse to open it.
xattr -dr com.apple.quarantine "$dest/Screening.app" 2>/dev/null || true

echo "Installed $dest/Screening.app. Opening it now."
echo "Buddy appears at the notch; the island icon is in the menu bar."
open "$dest/Screening.app"
