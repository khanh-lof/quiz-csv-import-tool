import { Routes } from '@angular/router';
import { LoginComponent } from '../components/login/login';
import { VocabularyTable } from '../components/vocabulary-table/vocabulary-table';
import { OfflineComponent } from '../components/offline/offline';
import { Workspace } from '../components/workspace/workspace';
import { AiGeneration, canLeaveAiGeneration } from '../components/ai-generation/ai-generation';
import { authGuard } from '../services/auth.guard';

export const routes: Routes = [
  {path: '', redirectTo: 'quiz', pathMatch: 'full'},
  {path: 'login', component: LoginComponent},
  {path: 'offline', component: OfflineComponent},
  // Both ways of building a quiz share one screen with a switch between them.
  {
    path: '', component: Workspace, children: [
      // Open to anonymous users.
      {path: 'quiz', component: VocabularyTable},
      // The server requires a token for AI generation.
      {path: 'ai', component: AiGeneration, canActivate: [authGuard], canDeactivate: [canLeaveAiGeneration]}
    ]
  },
  {path: '**', redirectTo: 'quiz'}
];
