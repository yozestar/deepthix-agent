// Graphical organisation chart: direction on top, one column per pole with
// its human managers and its agents (status light, Claude account, skills,
// pending validations). Click an agent to open its sheet.

import { useMemo } from 'react';

import type { AgentSummary, Pole } from './model';
import { Avatar } from './ui';

function statusOf(a: AgentSummary): { label: string; color: string } {
  if (a.en_pause) return { label: '⏸ En pause', color: 'var(--color-danger)' };
  if (a.statut === 'observation') return { label: '👁 Observation', color: 'var(--color-warning)' };
  return { label: '● En service', color: 'var(--color-status-success)' };
}

const LINE = '2px solid var(--color-border)';

export function Organigramme({
  poles,
  agents,
  onOpen,
  onNew,
}: {
  poles: Pole[];
  agents: AgentSummary[];
  onOpen: (id: string) => void;
  onNew: () => void;
}): React.JSX.Element {
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const directeur = 'Johann Chekroun';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          border: '2px solid var(--color-accent-bright)',
          background: 'var(--color-bg-dark)',
          boxShadow: 'var(--shadow-pixel)',
        }}
      >
        <Avatar name={directeur} size={40} />
        <div>
          <div style={{ fontWeight: 700 }}>{directeur}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>Direction · valide les mises en production</div>
        </div>
      </div>
      <div style={{ width: 2, height: 24, background: 'var(--color-border)' }} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', borderTop: LINE, paddingTop: 0 }}>
        {[...poles, { nom: '', responsables: [], agents: [] }].map((p) => (
          <div key={p.nom || 'nouveau'} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 250 }}>
            <div style={{ width: 2, height: 20, background: 'var(--color-border)' }} />
            {p.nom ? (
              <div style={{ width: '100%', border: LINE, background: 'var(--color-bg-dark)', boxShadow: 'var(--shadow-pixel)' }}>
                <div
                  style={{
                    padding: '6px 10px',
                    background: 'var(--color-active-bg)',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    fontSize: '0.75rem',
                    letterSpacing: 1,
                  }}
                >
                  {p.nom}
                </div>
                <div style={{ padding: 10 }}>
                  {p.responsables.map((r) => (
                    <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <Avatar name={r} />
                      <div>
                        <div style={{ fontSize: '0.8125rem' }}>{r}</div>
                        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>Responsable humain</div>
                      </div>
                    </div>
                  ))}
                  {p.agents.map((id) => {
                    const a = byId[id];
                    if (!a) return null;
                    const st = statusOf(a);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onOpen(id)}
                        style={{
                          display: 'block',
                          width: '100%',
                          marginBottom: 8,
                          padding: 8,
                          background: 'var(--color-bg)',
                          color: 'var(--color-text)',
                          border: '2px solid var(--color-accent)',
                          boxShadow: 'var(--shadow-pixel)',
                          fontFamily: 'var(--font-pixel)',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Avatar name={a.prenom} size={36} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 700 }}>
                              {a.prenom} <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>· agent</span>
                            </div>
                            <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>{a.role}</div>
                          </div>
                          {a.stats.validations_en_attente > 0 && (
                            <span
                              title="validations en attente"
                              style={{ background: 'var(--color-warning)', color: 'var(--color-on-accent)', padding: '0 6px', fontWeight: 700 }}
                            >
                              {a.stats.validations_en_attente}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: '0.6875rem' }}>
                          <span style={{ color: st.color }}>{st.label}</span>
                          <span style={{ color: 'var(--color-text-muted)' }}>{a.nb_competences} compétences</span>
                          <span style={{ color: 'var(--color-text-muted)' }}>{a.stats.missions_7j} missions / 7 j</span>
                        </div>
                        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                          compte Claude : {a.compte_claude ?? '—'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={onNew}
                style={{
                  width: '100%',
                  padding: 24,
                  border: '2px dashed var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text-muted)',
                  fontFamily: 'var(--font-pixel)',
                  cursor: 'pointer',
                }}
              >
                + Nouvel agent
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
