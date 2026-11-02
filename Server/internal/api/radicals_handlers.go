package api

import (
	"errors"
	"net/http"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/radicals"
	"quiz-csv-import-tool/server/internal/store"
)

// radicalsJob loads the caller's finished Radicals job, or answers why it cannot: 404 for no such job of the caller,
// 409 for a job that is no finished exercise.
func (s *Server) radicalsJob(w http.ResponseWriter, r *http.Request) (*store.Job, bool) {
	claims, _ := auth.FromContext(r.Context())
	if s.Jobs == nil {
		s.internalError(w, r, "jobs are not configured", errors.New("no job store"))
		return nil, false
	}
	job, err := s.Jobs.Get(r.Context(), claims.Username(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Job not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, "loading job failed", err)
		return nil, false
	}
	if job.Status != store.JobDone || !job.Creative || job.ExportType == nil || csvgen.ExportType(*job.ExportType) != csvgen.Radicals {
		writeText(w, http.StatusConflict, "Job is not a finished radicals exercise.")
		return nil, false
	}
	return job, true
}

// editableRadicalsJob is radicalsJob for the edit routes, which also need the source the exercise was built from:
// 409 for a job that has none (made before it was kept).
func (s *Server) editableRadicalsJob(w http.ResponseWriter, r *http.Request) (*store.Job, bool) {
	job, ok := s.radicalsJob(w, r)
	if ok && job.Source == "" {
		writeText(w, http.StatusConflict, "Job cannot be edited.")
		return nil, false
	}
	return job, ok
}

// radicalsEdit handles GET /api/csv/jobs/{id}/radicals: the table of what the teacher may correct in a finished
// Radicals exercise (csvgen.RadicalsEdit).
func (s *Server) radicalsEdit(w http.ResponseWriter, r *http.Request) {
	job, ok := s.editableRadicalsJob(w, r)
	if !ok {
		return
	}
	edit, err := csvgen.RadicalsEditOf(job.Source)
	if err != nil {
		s.internalError(w, r, "reading the exercise's source failed", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, edit)
}

// reviseRadicals handles PUT /api/csv/jobs/{id}/radicals: the teacher's corrections, the table of radicalsEdit with
// values changed. The exercise is built again from the job's source and saved on the job, without the model, so it
// uses none of the rate limit. 200 with the job as listJobs shows it; 422 with the table when some rows need
// another value (csvgen.ErrIncomplete), and nothing is saved then.
func (s *Server) reviseRadicals(w http.ResponseWriter, r *http.Request) {
	job, ok := s.editableRadicalsJob(w, r)
	if !ok {
		return
	}
	var corrections csvgen.RadicalsEdit
	if !s.readJSON(w, r, &corrections) {
		return
	}
	result, edit, err := csvgen.ReviseRadicals(job.Source, corrections)
	switch {
	case errors.Is(err, csvgen.ErrInvalidCorrections):
		writeText(w, http.StatusBadRequest, err.Error())
		return
	case errors.Is(err, csvgen.ErrIncomplete):
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusUnprocessableEntity, edit)
		return
	case errors.Is(err, radicals.ErrNothingToPlay):
		writeText(w, http.StatusConflict, err.Error())
		return
	case err != nil:
		s.internalError(w, r, "rebuilding the exercise failed", err)
		return
	}
	err = s.Jobs.Revise(r.Context(), job.Username, job.ID, result.CSV, result.Source)
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Job not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "saving the exercise failed", err)
		return
	}
	job.CSV = result.CSV
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.newJobView(job))
}
