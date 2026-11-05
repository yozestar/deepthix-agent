// Engine types, rule metadata and shared styles for the ÉQUIPE / MISSIONS tabs.

import type { CSSProperties } from 'react';

export interface AgentStats {
  missions_7j: number;
  actions_7j: number;
  refus_7j: number;
  validations_en_attente: number;
}
export interface AgentSummary {
  id: string;
  prenom: string;
  role?: string;
  pole?: string;
  responsable?: string;
  presentation_teams?: string;
  canal_teams?: string;
  compte_claude?: string | null;
  compte_secours?: string | null;
  statut?: string;
  niveau_initiative?: string;
  heures_calmes?: string;
  en_pause: boolean;
  nb_competences: number;
  stats: AgentStats;
  note_compte?: string;
  plafonds?: Record<string, number | undefined>;
  routines?: { nom: string; cron: string; competence: string }[];
}
export interface Pole {
  nom: string;
  responsables: string[];
  agents: string[];
}
export interface Regle {
  action: string;
  regle: 'seul' | 'demande' | 'interdit';
  cle?: string;
  valideur?: string;
  secours?: string;
  condition?: string;
  note?: string;
}
export interface Escalade {
  relance_apres_min?: number;
  prevenir_responsable_apres_min?: number;
  puis?: string;
  jamais_passer_outre?: boolean;
}
export interface Competence {
  nom: string;
  description: string;
}
export interface AgentDetail {
  agent: AgentSummary;
  acces: {
    outils_commandes?: Record<string, { action: string; sous_commandes?: Record<string, string> }>;
    lecture_dossiers?: string[];
    passbolt_dossiers?: string[];
    clients_exclus?: string[];
    ecriture_fichiers?: boolean;
  };
  regles: { regles: Regle[]; escalade?: Escalade };
  fiche: string;
  competences: Competence[];
  memoire: string;
}
export interface Compte {
  nom: string;
  libelle: string;
  max_simultanees: number;
  connecte: boolean;
  en_cours: number;
  en_attente: number;
  sature_jusqua: number | null;
  executions_24h: number;
  executions_7j: number;
  agents: string[];
}
export interface Commit {
  commit: string;
  date: string;
  auteur: string;
  message: string;
}
export interface Mission {
  id: number;
  agent: string;
  titre: string;
  demandeur: string;
  statut: string;
  depot: string | null;
  branche: string | null;
  ref_commit: string | null;
  ticket: string | null;
  cree_le: string;
  maj_le: string;
  alertes: string | null;
  resultat: string | null;
}
export interface Validation {
  id: number;
  mission_id: number;
  agent: string;
  action: string;
  detail: string;
  valideur: string;
  statut: 'en_attente' | 'accordee' | 'refusee';
  demande_le: string;
  repondu_le: string | null;
  repondu_par: string | null;
}

export const RULE_META: Record<Regle['regle'], { label: string; color: string }> = {
  seul: { label: '🟢 Seul', color: 'var(--color-status-success)' },
  demande: { label: '🟠 Demande', color: 'var(--color-warning)' },
  interdit: { label: '🔴 Interdit', color: 'var(--color-danger)' },
};

export const paneStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  background: 'var(--color-bg)',
  fontFamily: 'var(--font-pixel)',
  color: 'var(--color-text)',
};
export const inputStyle: CSSProperties = {
  background: 'var(--color-bg-dark)',
  color: 'var(--color-text)',
  border: '2px solid var(--color-border)',
  padding: '4px 8px',
  fontFamily: 'var(--font-pixel)',
  fontSize: '0.8125rem',
  width: '100%',
  boxSizing: 'border-box',
};


export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
