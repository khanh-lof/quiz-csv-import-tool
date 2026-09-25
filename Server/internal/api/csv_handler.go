package api

import (
	"context"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"

	"quiz-csv-import-tool/server/internal/csvgen"
	"quiz-csv-import-tool/server/internal/store"
)

const maxUploadBytes = 50 << 20

// generateCSV handles POST /api/csv/generate-from-image: a Bearer-authenticated multipart upload of
// zero or more images, rate-limited per user, answered with the CSV the model produced.
func (s *Server) generateCSV(w http.ResponseWriter, r *http.Request) {
	scheme, token, found := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	token = strings.TrimSpace(token)
	if !found || !strings.EqualFold(scheme, "Bearer") || token == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	claims, err := s.JWT.Parse(token)
	if err != nil {
		s.Logger.Warn("JWT validation failed", "error", err)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	user, err := s.Users.FindByUsername(r.Context(), claims.Name)
	if errors.Is(err, store.ErrNotFound) {
		writeText(w, http.StatusNotFound, "User not found")
		return
	}
	if err != nil {
		s.internalError(w, r, "loading user failed", err)
		return
	}
	if !claims.HasAnyRole("User", "Admin") {
		w.WriteHeader(http.StatusForbidden)
		return
	}

	images, uploadErr := readImages(w, r)
	if uploadErr != nil {
		writeText(w, uploadErr.status, uploadErr.msg)
		return
	}

	creative := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("isCreative")), "true")
	// Creative mode can work from the lesson identifiers alone; the formatted mode has nothing to
	// read without images.
	if !creative && len(images) == 0 {
		writeText(w, http.StatusBadRequest, "Image is required.")
		return
	}
	var opts csvgen.Options
	if creative {
		if opts, err = csvgen.ParseCreativeOptions(r.URL.Query()); err != nil {
			writeText(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	if s.Generator == nil {
		s.internalError(w, r, "CSV generation is not configured", errors.New("OPENAI_API_KEY, OPENAI_BASE_URL and LLM_MODEL must be set"))
		return
	}

	allowed, err := s.Users.TryConsumeAICall(r.Context(), user.Username, s.AICallsPerRound, s.RoundDuration)
	if err != nil {
		s.internalError(w, r, "updating AI call count failed", err)
		return
	}
	if !allowed {
		writeText(w, http.StatusForbidden, "You have reached the limit for AI calls.")
		return
	}

	ctx := r.Context()
	if s.LLMTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.LLMTimeout)
		defer cancel()
	}
	csv, err := s.Generator.Generate(ctx, images, creative, opts)
	if err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		// The client tells the user to send fewer images or retry on this status.
		s.Logger.Warn("CSV generation timed out", "user", user.Username, "images", len(images), "timeout", s.LLMTimeout)
		writeText(w, http.StatusGatewayTimeout, "AI generation timed out.")
		return
	}
	if err != nil {
		s.Logger.Error("CSV generation failed", "user", user.Username, "error", err)
		writeText(w, http.StatusBadGateway, "AI generation failed.")
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, csv)
}

// readImages collects every file part of the multipart body. A body with no file at all is fine:
// creative mode can run without images.
func readImages(w http.ResponseWriter, r *http.Request) ([]csvgen.Image, *requestError) {
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		return nil, &requestError{http.StatusBadRequest, "Missing Content-Type header"}
	}
	if !strings.Contains(strings.ToLower(contentType), "multipart/form-data") {
		return nil, &requestError{http.StatusBadRequest, "Expected multipart/form-data"}
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["boundary"] == "" {
		return nil, &requestError{http.StatusBadRequest, "Missing multipart boundary"}
	}

	reader := multipart.NewReader(http.MaxBytesReader(w, r.Body, maxUploadBytes), params["boundary"])
	var images []csvgen.Image
	for {
		part, err := reader.NextPart()
		// Only a bare io.EOF marks the closing delimiter; a wrapped EOF means the body was truncated
		// (even an empty multipart body must end with its closing delimiter).
		if err == io.EOF {
			return images, nil
		}
		if err != nil {
			return nil, uploadError(err)
		}

		disposition, dispParams, _ := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if disposition != "form-data" || dispParams["filename"] == "" {
			_ = part.Close()
			continue
		}
		data, err := io.ReadAll(part)
		if err != nil {
			return nil, uploadError(err)
		}
		partType := part.Header.Get("Content-Type")
		if partType == "" {
			partType = "application/octet-stream"
		}
		images = append(images, csvgen.Image{ContentType: partType, Data: data})
	}
}

// requestError is a client error to answer with as plain text.
type requestError struct {
	status int
	msg    string
}

func uploadError(err error) *requestError {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return &requestError{http.StatusRequestEntityTooLarge, "Upload is too large."}
	}
	return &requestError{http.StatusBadRequest, "Malformed multipart body."}
}
