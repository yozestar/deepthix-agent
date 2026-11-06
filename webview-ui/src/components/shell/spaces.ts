// Design v2 navigation: the app is split into SPACES (left rail). Each mode
// (the content of the main pane) belongs to exactly one space, so what
// concerns the open project never mixes with what concerns the whole company.

import type { Role } from '../../hooks/useRole';
import type { Mode } from '../TopTabs';

export type SpaceId = 'accueil' | 'projets' | 'equipe' | 'missions' | 'savoir' | 'outils' | 'conso' | 'reglages';

export interface SpaceMeta {
  id: SpaceId;
  emoji: string;
  label: string;
  title: string;
  subtitle: string;
  /** Modes shown as sub-tabs, in order. First = default. */
  modes: Mode[];
  /** Roles allowed to see the space. */
  roles: Role[];
  /** Pinned at the bottom of the rail. */
  bottom?: boolean;
}

export const MODE_LABELS: Partial<Record<Mode, string>> = {
  accueil: 'Accueil',
  sessions: 'Sessions',
  overview: "Vue d'ensemble",
  files: 'Fichiers',
  memory: 'Mémoire',
  tasks: 'Tâches',
  equipe: 'Équipe',
  missions: 'Missions',
  savoir: 'Compétences des agents',
  skills: 'Skills Claude',
  schedule: 'Planification',
  workflow: 'Workflows',
  variables: 'Variables',
  process: 'Processus',
  usage: 'Consommation',
  settings: 'Réglages',
};

export const SPACES: SpaceMeta[] = [
  { id: 'accueil', emoji: '🏠', label: 'Accueil', title: 'Accueil', subtitle: 'Ta journée en un coup d’œil', modes: ['accueil'], roles: ['admin', 'responsable', 'collab'] },
  {
    id: 'projets',
    emoji: '🗂️',
    label: 'Projets',
    title: 'Projets',
    subtitle: 'Le projet ouvert : ses sessions, ses fichiers, son tableau de bord',
    modes: ['sessions', 'overview', 'files', 'memory', 'tasks'],
    roles: ['admin', 'responsable', 'collab', 'local'],
  },
  { id: 'equipe', emoji: '🦊', label: 'Équipe', title: 'Équipe', subtitle: 'Humains et agents, droits des collègues', modes: ['equipe'], roles: ['admin', 'responsable'] },
  { id: 'missions', emoji: '✅', label: 'Missions', title: 'Missions', subtitle: 'Décisions à prendre et travaux en cours', modes: ['missions'], roles: ['admin', 'responsable', 'collab'] },
  { id: 'savoir', emoji: '🧠', label: 'Savoir', title: 'Savoir', subtitle: 'Ce qui rend les agents bons', modes: ['savoir', 'skills'], roles: ['admin', 'responsable'] },
  { id: 'outils', emoji: '🧰', label: 'Outils', title: 'Outils', subtitle: 'Planification, workflows, variables, processus', modes: ['schedule', 'workflow', 'variables', 'process'], roles: ['admin'] },
  { id: 'conso', emoji: '📊', label: 'Conso', title: 'Consommation', subtitle: 'Forfaits et activité', modes: ['usage'], roles: ['admin'] },
  { id: 'reglages', emoji: '⚙️', label: 'Réglages', title: 'Réglages', subtitle: '', modes: ['settings'], roles: ['admin', 'responsable', 'collab', 'local'], bottom: true },
];

export function spaceOf(mode: Mode): SpaceMeta {
  return SPACES.find((s) => s.modes.includes(mode)) ?? SPACES[1];
}

export function spacesFor(role: Role): SpaceMeta[] {
  return SPACES.filter((s) => s.roles.includes(role));
}
