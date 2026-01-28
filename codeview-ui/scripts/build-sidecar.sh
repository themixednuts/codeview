#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Building SvelteKit app..."
bun run build

TARGETS=(
  "bun-linux-x64"
  "bun-linux-arm64"
  "bun-darwin-x64"
  "bun-darwin-arm64"
  "bun-windows-x64"
)

SIDECAR_DIR="../codeview-cli/sidecar"
mkdir -p "$SIDECAR_DIR"

for target in "${TARGETS[@]}"; do
  outfile="$SIDECAR_DIR/codeview-server-$target"
  if [[ "$target" == *"windows"* ]]; then
    outfile="$outfile.exe"
  fi
  echo "Building for $target -> $outfile"
  bun build ./build/index.js --compile --target="$target" --outfile="$outfile"
done

echo "Done. Sidecar binaries in $SIDECAR_DIR:"
ls -lh "$SIDECAR_DIR"
