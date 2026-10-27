package api

import (
	"net/http"
	"strconv"

	"quiz-csv-import-tool/server/internal/extension"
)

// downloadExtension sends the Wayground browser extension as a zip, for a logged-in user to install.
func (s *Server) downloadExtension(w http.ResponseWriter, r *http.Request) {
	data, err := extension.Zip()
	if err != nil {
		s.Logger.Error("extension zip", "path", r.URL.Path, "error", err)
		writeText(w, http.StatusNotFound, "Extension not available.")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+extension.FileName+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", "private, no-cache")
	_, _ = w.Write(data)
}
