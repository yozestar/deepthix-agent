// CHAT space: talk to the agents like to colleagues. Left: the agents you may
// ask (as contacts) and your conversations with the selected one. Right: the
// conversation (MissionConversation) or a new one. Images: paste / drop / 📎.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { agentsApi } from '../../tauri/commands';
import { AgentComposer, MissionConversation } from './MissionThread';
import { type AgentSummary, errMsg } from './model';

interface Conv {
  id: number;
  titre: string;
  statut: string;
  maj_le: string;
}
const STATUT: Record<string, string> = { en_cours: '⏳', en_attente_validation: '🟠', terminee: '✓', erreur: '⚠', a_revalider: '⚠' };

export function AgentsChat(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [conv, setConv] = useState<number | 'nouvelle' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [st, moi] = await Promise.all([agentsApi<{ agents: AgentSummary[] }>('etat'), agentsApi<{ peut_demander?: string[] }>('moi')]);
        const ok = new Set(moi.peut_demander ?? []);
        const liste = st.agents.filter((a) => ok.has(a.id));
        setAgents(liste);
        if (liste.length) setAgent((x) => x ?? liste[0].id);
      } catch (e) {
        setError(errMsg(e));
      }
    })();
  }, []);

  const chargerConvs = useCallback(async (): Promise<void> => {
    if (!agent) return;
    try {
      const c = await agentsApi<Conv[]>('conversations', [agent]);
      setConvs(c);
      setConv((x) => (x === null ? (c[0]?.id ?? 'nouvelle') : x));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [agent]);
  useEffect(() => {
    setConv(null);
    void chargerConvs();
    const t = setInterval(() => void chargerConvs(), 10_000);
    return () => clearInterval(t);
  }, [chargerConvs]);

  const a = useMemo(() => agents.find((x) => x.id === agent), [agents, agent]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, fontFamily: 'var(--font-pixel)', color: 'var(--color-text)' }}>
      <div style={{ width: 270, flex: 'none', borderRight: '2px solid var(--color-border)', overflow: 'auto', padding: 10 }}>
        {error && <div style={{ color: 'var(--color-danger)', fontSize: 12.5, marginBottom: 8 }}>⚠ {error}</div>}
        {agents.map((x) => (
          <div key={x.id}>
            <button
              type="button"
              onClick={() => setAgent(x.id)}
              className="v2-hover-lift"
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                width: '100%',
                textAlign: 'left',
                padding: 8,
                marginBottom: 4,
                borderRadius: 14,
                cursor: 'pointer',
                border: `1px solid ${x.id === agent ? 'var(--color-accent-bright)' : 'transparent'}`,
                background: x.id === agent ? 'var(--color-active-bg)' : 'transparent',
                color: 'var(--color-text)',
              }}
            >
              <span style={{ width: 36, height: 36, borderRadius: 12, background: x.couleur ?? 'var(--gradient-accent)', display: 'grid', placeItems: 'center', fontSize: 19, flex: 'none' }}>
                {x.emoji ?? '🤖'}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 800, display: 'block' }}>
                  {x.prenom}
                  {x.en_pause && ' ⏸'}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.role}</span>
              </span>
            </button>
            {x.id === agent && (
              <div style={{ margin: '2px 0 10px 18px' }}>
                <button
                  type="button"
                  onClick={() => setConv('nouvelle')}
                  style={{ border: 'none', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer', padding: '4px 0', fontWeight: 700 }}
                >
                  ＋ Nouvelle conversation
                </button>
                {convs.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setConv(c.id)}
                    title={c.titre}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      borderRadius: 8,
                      padding: '5px 8px',
                      cursor: 'pointer',
                      fontSize: 12.5,
                      background: conv === c.id ? 'var(--color-btn-hover)' : 'transparent',
                      color: 'var(--color-text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {STATUT[c.statut] ?? '·'} {c.titre.replace(/\s+/g, ' ').trim() || `Mission #${c.id}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {!agents.length && !error && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Aucun agent ouvert pour toi pour l’instant.</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {a && conv === 'nouvelle' && (
          <>
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: 46 }}>{a.emoji ?? '🤖'}</div>
                <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>Nouvelle conversation avec {a.prenom}</div>
                <div style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>{a.role}</div>
                <div style={{ color: 'var(--color-text-muted)', marginTop: 12, fontSize: 13 }}>Écris comme à un collègue. Tu peux coller une capture d’écran.</div>
              </div>
            </div>
            <AgentComposer
              key={a.id}
              autoFocus
              agent={a.id}
              placeholder={`Écrire à ${a.prenom}…`}
              onSend={async (texte, pieces) => {
                const r = await agentsApi<{ mission?: number }>('demander', [a.id], { texte, pieces });
                await chargerConvs();
                if (r.mission) setConv(r.mission);
              }}
            />
          </>
        )}
        {a && typeof conv === 'number' && <MissionConversation key={conv} missionId={conv} />}
      </div>
    </div>
  );
}
