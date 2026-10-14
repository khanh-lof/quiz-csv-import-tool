import { Injectable } from '@angular/core';
import { HttpClient, HttpStatusCode } from '@angular/common/http';
import { catchError, map, Observable, of } from 'rxjs';
import {
  Assignment,
  AssignmentChange,
  AssignmentDetail,
  NewAssignment,
} from '../models/assignment';

// The teacher's side of "Giao bài": the assignments of the signed-in user. It holds no state, every page
// asks the server for what it shows, so a ranking page and the list never disagree about an old copy.
@Injectable({providedIn: 'root'})
export class AssignmentService {
  private readonly endpointUrl = '/api/assignments';

  constructor(private readonly http: HttpClient) {
  }

  create(request: NewAssignment): Observable<Assignment> {
    return this.http.post<Assignment>(this.endpointUrl, request);
  }

  // Newest first.
  list(): Observable<Assignment[]> {
    return this.http.get<{ assignments: Assignment[] }>(this.endpointUrl).pipe(map(body => body.assignments));
  }

  // The assignment with the quiz it snapshotted and its ranking.
  get(id: string): Observable<AssignmentDetail> {
    return this.http.get<AssignmentDetail>(`${this.endpointUrl}/${encodeURIComponent(id)}`);
  }

  update(id: string, change: AssignmentChange): Observable<Assignment> {
    return this.http.patch<Assignment>(`${this.endpointUrl}/${encodeURIComponent(id)}`, change);
  }

  // Deletes the assignment and its students' results. One that is already gone (another tab deleted it)
  // counts as deleted, like an AI job.
  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${this.endpointUrl}/${encodeURIComponent(id)}`).pipe(
      catchError(AssignmentService.alreadyGone));
  }

  removePlayer(id: string, playerId: string): Observable<void> {
    return this.http.delete<void>(
      `${this.endpointUrl}/${encodeURIComponent(id)}/players/${encodeURIComponent(playerId)}`).pipe(
      catchError(AssignmentService.alreadyGone));
  }

  private static alreadyGone(err: { status?: number }): Observable<void> {
    if (err?.status === HttpStatusCode.NotFound) {
      return of(undefined);
    }
    throw err;
  }
}
