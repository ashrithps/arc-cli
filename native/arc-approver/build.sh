#!/usr/bin/env bash
# Build arc-approver as a universal (arm64 + x86_64), ad-hoc signed binary.
#
#   native/arc-approver/build.sh [output-path]    default: ./build/arc-approver
#
# Prints the output path and its sha256. macOS only; needs swiftc (Xcode or the
# Command Line Tools). The installer runs this when no prebuilt release binary
# is pinned, and the release step runs it to produce that binary.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-${HERE}/build/arc-approver}"
MIN_MACOS="13.0"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "arc-approver builds on macOS only" >&2
  exit 1
fi

SWIFTC="$(xcrun --find swiftc)"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

for arch in arm64 x86_64; do
  "${SWIFTC}" -O -swift-version 5 -sdk "${SDK}" \
    -target "${arch}-apple-macos${MIN_MACOS}" \
    -o "${TMP}/arc-approver-${arch}" "${HERE}/main.swift"
done

mkdir -p "$(dirname "${OUT}")"
lipo -create -output "${TMP}/arc-approver" "${TMP}/arc-approver-arm64" "${TMP}/arc-approver-x86_64"
codesign -s - --force -i moi.arc.approver "${TMP}/arc-approver" >/dev/null 2>&1
mv -f "${TMP}/arc-approver" "${OUT}"
chmod 755 "${OUT}"

echo "${OUT}"
shasum -a 256 "${OUT}" | awk '{print "sha256 " $1}'
