//go:build embed_web

package main

import "embed"

//go:embed all:web
var embeddedWeb embed.FS

var webEmbedded = true
