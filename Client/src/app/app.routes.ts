import { Routes } from '@angular/router';
import { LoginComponent } from '../components/login/login';
import { VocabularyTable } from '../components/vocabulary-table/vocabulary-table';
import { OfflineComponent } from '../components/offline/offline';

export const routes: Routes = [
  {path: '', redirectTo: 'quiz', pathMatch: 'full'},
  {path: 'login', component: LoginComponent},
  {path: 'offline', component: OfflineComponent},
  // Open to anonymous users: only the AI generation popup needs a login, checked when it is opened.
  {path: 'quiz', component: VocabularyTable},
  {path: '**', redirectTo: 'quiz'}
];
