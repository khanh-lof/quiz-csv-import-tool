import { Routes } from '@angular/router';
import { LoginComponent } from '../components/login/login';
import { VocabularyTable } from '../components/vocabulary-table/vocabulary-table';
import { OfflineComponent } from '../components/offline/offline';
import { Workspace } from '../components/workspace/workspace';
import { AiGeneration } from '../components/ai-generation/ai-generation';
import { authGuard } from '../services/auth.guard';

export const routes: Routes = [
  {path: '', redirectTo: 'quiz', pathMatch: 'full'},
  {path: 'login', component: LoginComponent},
  {path: 'offline', component: OfflineComponent},
  // The gesture quiz is played full screen, outside the Workspace frame. It is loaded lazily so that
  // MediaPipe and the six games stay out of the initial bundle: only a player who opens it downloads them.
  // /play takes a quiz file (or the sample) and is open to anonymous users; /play/:jobId plays an AI job
  // of the signed-in user, so like /ai it needs a login.
  // The two assignment routes come before /play/:jobId: /play/s/:code is what a student opens from the
  // teacher's link, so it has no guard (the student has no account); /play/preview/:assignmentId is the
  // teacher trying the assignment out, and needs a login like the assignment pages do.
  {
    path: 'play',
    loadComponent: () => import('../components/gesture-play/gesture-play').then(m => m.GesturePlay)
  },
  {
    path: 'play/s/:code',
    loadComponent: () => import('../components/gesture-play/gesture-play').then(m => m.GesturePlay)
  },
  {
    path: 'play/preview/:assignmentId',
    loadComponent: () => import('../components/gesture-play/gesture-play').then(m => m.GesturePlay),
    canActivate: [authGuard]
  },
  {
    path: 'play/:jobId',
    loadComponent: () => import('../components/gesture-play/gesture-play').then(m => m.GesturePlay),
    canActivate: [authGuard]
  },
  // Both ways of building a quiz share one screen with a switch between them.
  {
    path: '', component: Workspace, children: [
      // Open to anonymous users.
      {path: 'quiz', component: VocabularyTable},
      // The server requires a token for AI generation.
      {path: 'ai', component: AiGeneration, canActivate: [authGuard]},
      // The teacher's assignments and their rankings: lazy, like the game, since only a teacher opens them.
      {
        path: 'assignments',
        loadComponent: () => import('../components/assignments/assignment-list/assignment-list')
          .then(m => m.AssignmentList),
        canActivate: [authGuard]
      },
      {
        path: 'assignments/:id',
        loadComponent: () => import('../components/assignments/assignment-ranking/assignment-ranking')
          .then(m => m.AssignmentRanking),
        canActivate: [authGuard]
      }
    ]
  },
  {path: '**', redirectTo: 'quiz'}
];
