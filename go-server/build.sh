#!/bin/bash
VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev")
go build -tags "fts5 sqlite_math_functions" -ldflags "-X main.version=${VERSION}" -o photo-loka .
