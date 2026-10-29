#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags='-s -w' \
    -o "$project_dir/vendor/ws-scrcpy/tcp-redirector-arm64.bin" \
    "$project_dir/vendor/ws-scrcpy/tcp-redirector.go"
