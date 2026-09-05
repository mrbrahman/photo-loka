//go:build !embed_web

package main

import "embed"

// Placeholder - no embedded web assets in dev builds.
// The server will read from ../web on disk instead.
var embeddedWeb embed.FS

var webEmbedded = false
