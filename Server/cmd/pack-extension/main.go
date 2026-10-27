// Command pack-extension writes the Wayground extension's zip that the server embeds. It is run by
// `go generate ./internal/extension`: pack-extension <extension dir> <output zip>.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"quiz-csv-import-tool/server/internal/extension"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: pack-extension <extension dir> <output zip>")
		os.Exit(2)
	}
	dir, output := os.Args[1], os.Args[2]
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err != nil {
		fmt.Fprintf(os.Stderr, "no manifest.json in %s: %v\n", dir, err)
		os.Exit(1)
	}
	data, err := extension.Pack(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(output, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
