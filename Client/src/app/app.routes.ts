import { Routes } from '@angular/router';
import { LoginComponent } from '../components/login/login';
import { authGuard } from '../services/auth.guard';
import { VocabularyTable } from '../components/vocabulary-table/vocabulary-table';

export const routes: Routes = [
  { path: '', redirectTo: 'quiz', pathMatch: 'full' },
  { path: 'login', component: LoginComponent },
  {
    path: 'quiz',
    component: VocabularyTable,
    canActivate: [authGuard]
  },
  { path: '**', redirectTo: 'quiz' }
];
