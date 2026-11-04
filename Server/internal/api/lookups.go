package api

import (
	"errors"
	"net/http"

	"quiz-csv-import-tool/server/internal/auth"
	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

// callerName is the username of a request that went through authenticate, which always puts the claims in
// the context.
func callerName(r *http.Request) string {
	claims, _ := auth.FromContext(r.Context())
	return claims.Username()
}

// jobStoreReady answers 500 and reports false when the server was started without a job store.
func (s *Server) jobStoreReady(w http.ResponseWriter, r *http.Request) bool {
	if s.Jobs == nil {
		s.internalError(w, r, "jobs are not configured", errors.New("no job store"))
		return false
	}
	return true
}

// ownedJob is the user's job, or a 404 "Job not found" for another user's or none at all.
func (s *Server) ownedJob(w http.ResponseWriter, r *http.Request, username, id string) (*store.Job, bool) {
	job, err := s.Jobs.Get(r.Context(), username, id)
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Job not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, "loading job failed", err)
		return nil, false
	}
	return job, true
}

// ownedAssignment is the user's assignment, or a 404 "Assignment not found" for another user's or none at
// all: a teacher never learns that someone else's exists.
func (s *Server) ownedAssignment(w http.ResponseWriter, r *http.Request, username, id string) (*store.Assignment, bool) {
	a, err := s.Assignments.Get(r.Context(), username, id)
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "Assignment not found")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, "loading assignment failed", err)
		return nil, false
	}
	return a, true
}

// isFinishedJobOf reports whether the job is a done creative job of the platform.
func isFinishedJobOf(job *store.Job, exportType csvgen.ExportType) bool {
	return job.Status == store.JobDone && job.Creative && job.ExportType != nil && csvgen.ExportType(*job.ExportType) == exportType
}
