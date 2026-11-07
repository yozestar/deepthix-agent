// MISSIONS tab: pending validations (approve / refuse — the engine's guard
// lets the exact action through once approved) + the missions board.

import { useCallback, useEffect, useState } from 'react';

import { agentsApi } from '../../tauri/commands';
import { MissionThread } from './MissionThread';
import { errMsg, type Mission, paneStyle, type Validation } from './model';
import { Btn, Card, Chip } from './ui';

const COLUMNS: ReadonlyArray<{ statut: string[]; label: string; color: string }> = [
  { statut: ['en_cours', 'demandee'], label: 'En cours', color: 'var(--color-status-active)' },
  { statut: ['en_attente_validation'], label: 'À valider', color: 'var(--color-warning)' },
  { statut: ['a_revalider', 'erreur'], label: 'Bloqué / à revalider', color: 'var(--color-danger)' },
  { statut: ['terminee', 'livree'], label: 'Fait', color: 'var(--color-status-success)' },
];

export function MissionsPane(): React.JSX.Element {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [validations, setValidations] = useState<Validation[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtre, setFiltre] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await agentsApi<{ missions: Mission[]; validations: Validation[] }>('missions');
      setMissions(r.missions);
      setValidations(r.validations);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const decide = (v: Validation, d: 'accorder' | 'refuser'): void => {
    void agentsApi('valider', [String(v.id), d, 'relancer'], { motif: '' })
      .then(() => refresh())
      .catch((e) => setError(errMsg(e)));
  };

  const pending = validations.filter((v) => v.statut === 'en_attente');
  const q = filtre.trim().toLowerCase();
  const shown = missions.filter((m) => !q || `${m.agent} ${m.titre} ${m.demandeur} ${m.ticket ?? ''}`.toLowerCase().includes(q));

  return (
    <div style={paneStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
        }}
      >
        <span style={{ color: 'var(--color-accent)', fontWeight: 700 }}>MISSIONS</span>
        <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
          {missions.length} missions · {pending.length} validation(s) en attente
        </span>
        <span style={{ flex: 1 }} />
        <input
          placeholder="🔍 agent, titre, ticket…"
          value={filtre}
          onChange={(e) => setFiltre(e.target.value)}
          style={{
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
            border: '2px solid var(--color-border)',
            fontFamily: 'var(--font-pixel)',
            padding: '3px 8px',
          }}
        />
      </div>
      {error && <div style={{ padding: 10, background: 'var(--color-danger)', color: 'var(--color-on-accent)' }}>{error}</div>}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
        {pending.length > 0 && (
          <Card title={`🟠 Validations en attente (${pending.length})`}>
            {pending.map((v) => (
              <div
                key={v.id}
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}
              >
                <span style={{ flex: 1, fontSize: '0.8125rem' }}>
                  <b>{v.agent}</b> demande : {v.action}
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>{v.detail}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                    mission #{v.mission_id} · valideur prévu : {v.valideur || '—'} · demandé le {v.demande_le}
                  </div>
                </span>
                <Btn kind="success" onClick={() => decide(v, 'accorder')}>
                  ✓ Valider
                </Btn>
                <Btn kind="danger" onClick={() => decide(v, 'refuser')}>
                  ✕ Refuser
                </Btn>
              </div>
            ))}
          </Card>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(220px, 1fr))`, gap: 12 }}>
          {COLUMNS.map((col) => {
            const items = shown.filter((m) => col.statut.includes(m.statut));
            return (
              <div key={col.label}>
                <div style={{ color: col.color, fontWeight: 700, marginBottom: 8 }}>
                  {col.label} ({items.length})
                </div>
                {items.slice(0, 50).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setOpen(m.id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      marginBottom: 8,
                      padding: 8,
                      background: 'var(--color-bg-dark)',
                      color: 'var(--color-text)',
                      border: `2px solid ${open === m.id ? col.color : 'var(--color-border)'}`,
                      boxShadow: 'var(--shadow-pixel)',
                      fontFamily: 'var(--font-pixel)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: '0.8125rem' }}>
                      #{m.id} · <b>{m.agent}</b> — {m.titre}
                    </div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                      {m.demandeur} · {m.maj_le}
                      {m.ticket && ` · ticket #${m.ticket}`}
                      {m.depot && ` · ${m.depot}@${m.ref_commit ?? '?'}`}
                    </div>
                    {m.alertes && <Chip color="var(--color-warning)">⚠ travaux des autres signalés</Chip>}
                    <div style={{ fontSize: '0.6875rem', color: 'var(--color-accent)', marginTop: 4 }}>💬 ouvrir la conversation</div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {open !== null && <MissionThread missionId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
