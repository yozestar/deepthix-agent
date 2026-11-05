// Access editor: click the tools the agent may use (read-only tools in blue,
// controlled-write tools in orange), the Passbolt folders it may read, file
// writing in its own workspace, excluded clients, and its scheduled routines.
// Anything not switched on here is refused by the guard.

import { useState } from 'react';

import { inputStyle } from './model';
import { Btn, Card } from './ui';

export interface Outil {
  chemin: string;
  nom: string;
  description: string;
  ecriture: boolean;
}
export interface Routine {
  nom: string;
  cron: string;
  competence: string;
}
export interface AccesValue {
  outils_commandes: Record<string, { action: string; sous_commandes?: Record<string, string> }>;
  passbolt_dossiers: string[];
  ecriture_fichiers: boolean;
  clients_exclus: string[];
}

const PASSBOLT = ['Dev/Clients', 'Dev/Facturation électronique', 'Dev/Infra Elyone', 'Dev/Plateformes'];
const CRON_EXEMPLES: ReadonlyArray<[string, string]> = [
  ['*/5 * * * *', 'toutes les 5 min'],
  ['0 7 * * 1-5', 'chaque matin 7 h (lun-ven)'],
  ['30 7 * * 1-5', 'chaque matin 7 h 30 (lun-ven)'],
  ['0 18 * * 5', 'vendredi 18 h'],
  ['0 2 * * *', 'chaque nuit 2 h'],
];

function Toggle({ on, color, label, title, onClick }: { on: boolean; color: string; label: string; title?: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        padding: '4px 10px',
        margin: '3px 6px 3px 0',
        fontFamily: 'var(--font-pixel)',
        fontSize: '0.75rem',
        cursor: 'pointer',
        border: `2px solid ${on ? color : 'var(--color-border)'}`,
        background: on ? color : 'transparent',
        color: on ? 'var(--color-on-accent)' : 'var(--color-text-muted)',
        boxShadow: on ? 'var(--shadow-pixel)' : 'none',
      }}
    >
      {on ? '✓ ' : ''}
      {label}
    </button>
  );
}

export function AccesEditor({
  value,
  outils,
  routines,
  competences,
  busy,
  onSave,
}: {
  value: AccesValue;
  outils: Outil[];
  routines: Routine[];
  competences: string[];
  busy: boolean;
  onSave: (a: AccesValue, r: Routine[]) => void;
}): React.JSX.Element {
  const [v, setV] = useState<AccesValue>(value);
  const [rt, setRt] = useState<Routine[]>(routines);
  const [exclu, setExclu] = useState('');
  const toggleOutil = (o: Outil): void =>
    setV((x) => {
      const next = { ...x.outils_commandes };
      if (next[o.chemin]) delete next[o.chemin];
      else
        next[o.chemin] = o.ecriture
          ? { action: 'push_branche_agent', sous_commandes: { branche: 'push_branche_agent', commit: 'push_branche_agent', push: 'push_branche_agent', pr: 'pull_request' } }
          : { action: 'lecture' };
      return { ...x, outils_commandes: next };
    });
  const togglePb = (p: string): void =>
    setV((x) => ({ ...x, passbolt_dossiers: x.passbolt_dossiers.includes(p) ? x.passbolt_dossiers.filter((y) => y !== p) : [...x.passbolt_dossiers, p] }));

  return (
    <Card
      title="Accès et tâches planifiées"
      right={
        <Btn kind="primary" disabled={busy} onClick={() => onSave(v, rt)}>
          Enregistrer
        </Btn>
      }
    >
      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: 6 }}>
        Cliquez pour ouvrir ou fermer. Tout ce qui est fermé est refusé par le garde-fou.
      </div>
      <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginTop: 6 }}>Outils</div>
      {outils.map((o) => (
        <Toggle
          key={o.chemin}
          on={Boolean(v.outils_commandes[o.chemin])}
          color={o.ecriture ? 'var(--color-warning)' : 'var(--color-status-active)'}
          label={`${o.nom}${o.ecriture ? ' (écriture contrôlée)' : ' (lecture)'}`}
          title={o.description}
          onClick={() => toggleOutil(o)}
        />
      ))}
      <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginTop: 10 }}>Coffre Passbolt (lecture des secrets, jamais affichés)</div>
      {PASSBOLT.map((p) => (
        <Toggle key={p} on={v.passbolt_dossiers.some((x) => x.startsWith(p))} color="var(--color-accent-bright)" label={`🔑 ${p}`} onClick={() => togglePb(p)} />
      ))}
      <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginTop: 10 }}>Fichiers</div>
      <Toggle
        on={v.ecriture_fichiers}
        color="var(--color-warning)"
        label="Écrire des fichiers dans son propre espace de travail (copies fraîches)"
        onClick={() => setV((x) => ({ ...x, ecriture_fichiers: !x.ecriture_fichiers }))}
      />
      <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginTop: 10 }}>Clients exclus</div>
      {v.clients_exclus.map((c) => (
        <Toggle key={c} on color="var(--color-danger)" label={`✕ ${c}`} title="Cliquer pour retirer l'exclusion" onClick={() => setV((x) => ({ ...x, clients_exclus: x.clients_exclus.filter((y) => y !== c) }))} />
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <input style={inputStyle} placeholder="Exclure un client (nom tel que dans Odoo)" value={exclu} onChange={(e) => setExclu(e.target.value)} />
        <Btn
          disabled={!exclu.trim()}
          onClick={() => {
            setV((x) => ({ ...x, clients_exclus: [...x.clients_exclus, exclu.trim()] }));
            setExclu('');
          }}
        >
          + Exclure
        </Btn>
      </div>

      <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginTop: 14 }}>🕐 Tâches planifiées</div>
      {rt.map((r, i) => (
        <div key={`${r.nom}-${i}`} style={{ display: 'grid', gridTemplateColumns: '1fr 210px 220px auto', gap: 8, marginTop: 6 }}>
          <input style={inputStyle} value={r.nom} onChange={(e) => setRt((x) => x.map((y, j) => (j === i ? { ...y, nom: e.target.value } : y)))} />
          <select style={inputStyle} value={r.cron} onChange={(e) => setRt((x) => x.map((y, j) => (j === i ? { ...y, cron: e.target.value } : y)))}>
            {[...new Set([r.cron, ...CRON_EXEMPLES.map((c) => c[0])])].map((c) => (
              <option key={c} value={c}>
                {CRON_EXEMPLES.find((x) => x[0] === c)?.[1] ?? c}
              </option>
            ))}
          </select>
          <select style={inputStyle} value={r.competence} onChange={(e) => setRt((x) => x.map((y, j) => (j === i ? { ...y, competence: e.target.value } : y)))}>
            {[...new Set([r.competence, ...competences])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Btn onClick={() => setRt((x) => x.filter((_, j) => j !== i))}>✕</Btn>
        </div>
      ))}
      <div style={{ marginTop: 6 }}>
        <Btn onClick={() => setRt((x) => [...x, { nom: 'Nouvelle tâche', cron: '0 7 * * 1-5', competence: competences[0] ?? '' }])}>+ Ajouter une tâche planifiée</Btn>
      </div>
    </Card>
  );
}
