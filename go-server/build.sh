#!/bin/bash

PS4='+$(date +%H:%M:%S.%3N) '
#set -x

VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev")

TAGS="fts5 sqlite_math_functions"

# If on an exact tag (release build), embed web assets into the binary
if git describe --tags --exact-match HEAD &>/dev/null; then
    echo "Release build: embedding web assets"
    cp -r ../web web
    TAGS="$TAGS embed_web"
else
    echo "Dev build: web assets served from ../web at runtime"
fi

go build -tags "$TAGS" -ldflags "-X main.version=${VERSION}" -o photo-loka .

# Clean up if we copied web/
rm -rf web
