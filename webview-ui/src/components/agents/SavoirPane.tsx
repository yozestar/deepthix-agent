// SAVOIR (design v2): the agents' skills library — what they know how to do.
// Searchable cards; each skill shows which agents have it.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { agentsApi } from '../../tauri/commands';
import { CompetencePanel } from './CompetencePanel';
import { type AgentSummary, type Competence, errMsg } from './model';

export function SavoirPane(): React.JSX.Element {
  const [lib, setLib] = useState<Competence[]>([]);
  const [owners, setOwners] = useState<Record<string, string[]>>({});
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ouverte, setOuverte] = useState<string | null>(null);
  const [props, setProps] = useState<Record<string, number>>({});
  const chargerProps = useCallback((): void => {
    void agentsApi<Record<string, number>>('propositions_en_attente').then(setProps).catch(() => undefined);
  }, []);
  useEffect(() => chargerProps(), [chargerProps]);

  useEffect(() => {
    void (async () => {
      try {
        setLib(await agentsApi<Competence[]>('bibliotheque'));
        const st = await agentsApi<{ agents: AgentSummary[] }>('etat');
        setAgents(st.agents);
        const map: Record<string, string[]> = {};
        for (const a of st.agents) {
          const d = await agentsApi<{ competences: Competence[] }>('agent', [a.id]);
          for (const c of d.competences) (map[c.nom] ??= []).push(a.id);
        }
        setOwners(map);
      } catch (e) {
        setError(errMsg(e));
      }
    })();
  }, []);

  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  const s = q.trim().toLowerCase();
  const shown = lib
    .filter((c) => !s || `${c.nom} ${c.description}`.toLowerCase().includes(s))
    .sort((a, b) => (props[b.nom] ?? 0) - (props[a.nom] ?? 0));
  const nbProps = Object.values(props).reduce((x, y) => x + y, 0);

  return (
    <div className="v2-fade" style={{ flex: 1, overflow: 'auto', padding: '6px 22px 30px', fontFamily: 'var(--font-pixel)', color: 'var(--color-text)' }}>
      {error && <div style={{ color: 'var(--color-danger)', marginBottom: 10 }}>⚠ {error}</div>}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 Chercher une compétence : sage, mot de passe, odoo, connecteur…"
          style={{
            flex: 1,
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 14,
            padding: '12px 14px',
            color: 'var(--color-text)',
            fontSize: 14,
          }}
        />
        <span style={{ color: 'var(--color-text-muted)' }}>
          {shown.length} / {lib.length} compétences{nbProps > 0 && ` · 💡 ${nbProps} proposition(s) des agents à relire`}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
        {shown.map((c) => (
          <div
            key={c.nom}
            onClick={() => setOuverte(c.nom)}
            title="Lire, modifier, voir l’historique et les propositions"
            className="v2-hover-lift"
            style={{
              background: 'var(--color-bg-dark)',
              border: '1px solid var(--color-border)',
              borderRadius: 18,
              padding: 14,
              boxShadow: 'var(--shadow-pixel)',
              cursor: 'pointer',
            }}
          >
            {(props[c.nom] ?? 0) > 0 && <div style={{ fontSize: 12, color: 'var(--color-warning)', marginBottom: 4 }}>💡 {props[c.nom]} proposition(s) à relire</div>}
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{c.description || c.nom}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>{c.nom}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {(owners[c.nom] ?? []).map((id) => (
                <span key={id} style={{ fontSize: 12, padding: '3px 9px', borderRadius: 999, background: 'var(--color-btn-bg)' }}>
                  {byId[id]?.emoji ?? '🤖'} {byId[id]?.prenom ?? id}
                </span>
              ))}
              {!owners[c.nom] && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>aucun agent ne l’a encore</span>}
            </div>
          </div>
        ))}
      </div>
      {ouverte && <CompetencePanel nom={ouverte} onClose={() => setOuverte(null)} onChange={chargerProps} />}
    </div>
  );
}
