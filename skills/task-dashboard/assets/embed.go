package assets

import "embed"

// Files contains only viewer resources, never task reports or private state.
//
//go:embed *.html *.mjs *.css
var Files embed.FS
