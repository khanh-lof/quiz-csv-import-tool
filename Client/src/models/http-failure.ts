import { HttpErrorResponse } from '@angular/common/http';

export interface HttpFailure<Status = number | null> {
  status: Status;
  body: string;
}

// The status and the plain-text body of a failed request, which is how the server words its refusals. Something
// that is not an HTTP failure has no status (null, or `nonHttpStatus` when the caller reads it as one).
export function httpFailure(err: unknown): HttpFailure;
export function httpFailure(err: unknown, nonHttpStatus: number): HttpFailure<number>;
export function httpFailure(err: unknown, nonHttpStatus: number | null = null): HttpFailure {
  return err instanceof HttpErrorResponse
    ? {
      status: err.status,
      body: typeof err.error === 'string' ? err.error.trim() : ''
    }
    : {
      status: nonHttpStatus,
      body: ''
    };
}
