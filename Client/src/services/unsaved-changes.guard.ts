import { CanDeactivateFn } from '@angular/router';
import { Observable } from 'rxjs';

// A page that may hold changes the user has not saved yet.
export interface LeaveCheck {
  canLeave(): boolean | Observable<boolean>;
}

export const unsavedChangesGuard: CanDeactivateFn<LeaveCheck> = component => component.canLeave();
