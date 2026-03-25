#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE_PNG="$ROOT_DIR/assets/icon.png"
OUTPUT_ICNS="$ROOT_DIR/assets/icon.icns"
ICONSET_DIR="$ROOT_DIR/assets/icon.iconset"

if ! command -v sips >/dev/null 2>&1; then
  echo "sips is required to build the macOS icon."
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required to build the macOS icon."
  exit 1
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

create_icon() {
  size="$1"
  filename="$2"
  sips -z "$size" "$size" "$SOURCE_PNG" --out "$ICONSET_DIR/$filename" >/dev/null
}

create_icon 16 icon_16x16.png
create_icon 32 icon_16x16@2x.png
create_icon 32 icon_32x32.png
create_icon 64 icon_32x32@2x.png
create_icon 128 icon_128x128.png
create_icon 256 icon_128x128@2x.png
create_icon 256 icon_256x256.png
create_icon 512 icon_256x256@2x.png
create_icon 512 icon_512x512.png
create_icon 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"
rm -rf "$ICONSET_DIR"

echo "Built macOS app icon at $OUTPUT_ICNS"
