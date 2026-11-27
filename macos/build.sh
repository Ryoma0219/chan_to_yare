#!/bin/bash
# Chan to Yare.app を組み立てる (Xcode プロジェクトは使わない)
#
#   ./build.sh          ~/Applications/Chan to Yare.app を作り直す
#   ./build.sh --open   作り直してから開く
#
# 動いているアプリは終了させてから置き換える。
set -euo pipefail

cd "$(dirname "$0")"
APP="$HOME/Applications/Chan to Yare.app"
BUILD="build"
BUNDLE_ID="com.ryoma0219.chan-to-yare"
mkdir -p "$BUILD" "$HOME/Applications"

echo "==> compile"
swiftc -O -swift-version 5 -target arm64-apple-macos13.0 -o "$BUILD/ChanToYare" ChanToYare.swift

if [[ ! -f "$BUILD/AppIcon.icns" || make-icon.swift -nt "$BUILD/AppIcon.icns" ]]; then
  echo "==> icon"
  swiftc -O -o "$BUILD/make-icon" make-icon.swift
  "$BUILD/make-icon" "$BUILD/icon-1024.png"
  rm -rf "$BUILD/AppIcon.iconset"
  mkdir "$BUILD/AppIcon.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$BUILD/icon-1024.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$BUILD/icon-1024.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns -o "$BUILD/AppIcon.icns" "$BUILD/AppIcon.iconset"
fi

if pgrep -f "Chan to Yare.app/Contents/MacOS/ChanToYare" >/dev/null; then
  echo "==> quit running app"
  osascript -e "quit app id \"$BUNDLE_ID\"" || true
  for _ in $(seq 1 20); do pgrep -f "Chan to Yare.app/Contents/MacOS/ChanToYare" >/dev/null || break; sleep 0.25; done
fi

echo "==> bundle: $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/ChanToYare" "$APP/Contents/MacOS/ChanToYare"
cp Info.plist "$APP/Contents/Info.plist"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

echo "==> sign (ad hoc)"
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"
codesign --verify --strict "$APP"

# Finder と Dock に新しいアイコンと Info.plist を読ませる
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
touch "$APP"

if [[ "${1:-}" == "--open" ]]; then
  open "$APP"
fi
echo "==> done"
