// ACCUEIL (design v2): greeting of the day, the agents as living characters
// (spinning ring while they work), decisions waiting (one-click yes / no),
// "ask an agent" and the latest activity. Same page for the administrator and
// collaborators; collaborators simply don't get the configuration spaces.

import { useCallback, useEffect, useState } from 'react';

import type { Role } from '../../hooks/useRole';
import { agentsApi } from '../../tauri/commands';
import { errMsg } from './model';

interface HomeAgent {
  id: string;
  prenom: string;
  role: string;
  responsable: string;
  emoji: string;
  couleur?: string | null;
  statut?: string;
  en_pause: boolean;
  en_cours: string | null;
  faites_24h: number;
  faites_7j: number;
  a_valider: number;
}
interface HomeValidation {
  id: number;
  mission_id: number;
  agent: string;
  action: string;
  detail: string;
  valideur: string;
  demande_le: string;
}
interface Recent {
  id: number;
  agent: string;
  titre: string;
  statut: string;
  maj_le: string;
  ticket: string | null;
}
interface Home {
  agents: HomeAgent[];
  validations: HomeValidation[];
  recentes: Recent[];
}

const NAME_KEY = 'elyone.myName';
const card: React.CSSProperties = {
  background: 'var(--color-bg-dark)',
  border: '1px solid var(--color-border)',
  borderRadius: 20,
  padding: 18,
  boxShadow: 'var(--shadow-pixel)',
};
const h2: React.CSSProperties = { fontSize: 14, margin: '22px 0 10px', color: 'var(--color-text-muted)', fontWeight: 700 };

function greeting(): { word: string; icon: string } {
  const h = new Date().getHours();
  if (h < 6) return { word: 'Bonne nuit', icon: '🌙' };
  if (h < 12) return { word: 'Bonjour', icon: '☀️' };
  if (h < 18) return { word: 'Bon après-midi', icon: '🌤️' };
  return { word: 'Bonsoir', icon: '🌆' };
}

function Face({ a, size = 64 }: { a: Pick<HomeAgent, 'emoji' | 'couleur' | 'en_cours'>; size?: number }): React.JSX.Element {
  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        flex: 'none',
        borderRadius: size * 0.31,
        background: a.couleur ?? 'var(--gradient-accent)',
        display: 'grid',
        placeItems: 'center',
        fontSize: size * 0.53,
      }}
    >
      {a.en_cours && (
        <span
          style={{
            position: 'absolute',
            inset: -4,
            borderRadius: size * 0.37,
            border: '3px solid transparent',
            borderTopColor: 'var(--color-accent-bright)',
            borderRightColor: 'var(--color-accent)',
            animation: 'v2-spin 2.2s linear infinite',
          }}
        />
      )}
      {a.emoji}
    </div>
  );
}

export function HomePane({ role, myName, onGo }: { role: Role; myName?: string | null; onGo: (where: 'missions' | 'equipe') => void }): React.JSX.Element {
  const [home, setHome] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [askTo, setAskTo] = useState('');
  const [askText, setAskText] = useState('');
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const shownName = (myName ?? '').split(' ')[0] || name;

  const refresh = useCallback(async () => {
    try {
      const h = await agentsApi<Home>('accueil');
      setHome(h);
      setAskTo((x) => x || h.agents[0]?.id || '');
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const notify = (m: string): void => {
    setToast(m);
    setTimeout(() => setToast(null), 2800);
  };
  const decide = (v: HomeValidation, ok: boolean): void => {
    void agentsApi('valider', [String(v.id), ok ? 'accorder' : 'refuser', 'relancer'], { motif: '' })
      .then(() => {
        notify(ok ? '✓ Validé — l’agent reprend le travail' : 'Refusé — l’agent proposera autre chose');
        return refresh();
      })
      .catch((e) => setError(errMsg(e)));
  };
  const ask = (): void => {
    if (!askText.trim() || !askTo) return;
    void agentsApi('demander', [askTo, name || 'collègue'], { texte: askText.trim() })
      .then(() => {
        const ag = home?.agents.find((a) => a.id === askTo);
        notify(`Envoyé — ${ag?.prenom ?? 'l’agent'} s’en occupe ✨`);
        setAskText('');
        return refresh();
      })
      .catch((e) => setError(errMsg(e)));
  };

  const g = greeting();
  const agents = home?.agents ?? [];
  const vals = home?.validations ?? [];
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const done24 = agents.reduce((n, a) => n + a.faites_24h, 0);
  const busy = agents.filter((a) => a.en_cours);

  return (
    <div className="v2-fade" style={{ flex: 1, overflow: 'auto', padding: '6px 22px 30px', fontFamily: 'var(--font-pixel)', color: 'var(--color-text)' }}>
      {error && <div style={{ ...card, borderColor: 'var(--color-danger)', marginBottom: 12 }}>⚠ {error}</div>}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: 22,
          borderRadius: 24,
          background: 'var(--color-active-bg)',
          border: '1px solid var(--color-border)',
        }}
      >
        <div style={{ fontSize: 40, animation: 'v2-float 3s ease-in-out infinite' }}>{g.icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 800 }}>
            {g.word}{' '}
            {shownName ? (
              `${shownName} !`
            ) : (
              <input
                placeholder="ton prénom"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = (e.target as HTMLInputElement).value.trim();
                    if (v) {
                      localStorage.setItem(NAME_KEY, v);
                      setName(v);
                    }
                  }
                }}
                style={{ background: 'transparent', border: 'none', borderBottom: '1px dashed var(--color-text-muted)', color: 'var(--color-text)', fontSize: 18, width: 160 }}
              />
            )}
          </div>
          <div style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>
            {busy.length > 0 ? `${busy.map((a) => a.prenom).join(' et ')} ${busy.length > 1 ? 'travaillent' : 'travaille'} en ce moment. ` : ''}
            {done24 > 0 ? `${done24} tâche${done24 > 1 ? 's' : ''} terminée${done24 > 1 ? 's' : ''} ces dernières 24 h. ` : ''}
            {vals.length > 0 ? <b style={{ color: 'var(--color-text)' }}>{vals.length} décision{vals.length > 1 ? 's' : ''} t’attend{vals.length > 1 ? 'ent' : ''}.</b> : 'Rien ne t’attend, tout roule 🎉'}
          </div>
        </div>
        {vals.length > 0 && (
          <button
            type="button"
            onClick={() => onGo('missions')}
            style={{ border: 'none', borderRadius: 12, padding: '10px 16px', fontWeight: 700, background: 'var(--gradient-accent)', color: 'var(--color-on-accent)', cursor: 'pointer' }}
          >
            Voir les décisions →
          </button>
        )}
      </div>

      <div style={h2}>{role === 'admin' || role === 'responsable' ? 'Ton équipe d’agents, en direct' : 'Les agents qui peuvent t’aider'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
        {agents.map((a) => (
          <div key={a.id} className="v2-hover-lift" style={card}>
            <Face a={a} />
            <div style={{ fontSize: 17, fontWeight: 800, marginTop: 12 }}>{a.prenom}</div>
            <div style={{ color: 'var(--color-text-muted)', fontSize: 12.5 }}>
              {a.role} · avec {a.responsable.split(' ')[0]}
            </div>
            <div style={{ marginTop: 10, fontSize: 13, minHeight: 36 }}>
              {a.en_pause ? (
                <span style={{ color: 'var(--color-danger)' }}>⏸ en pause</span>
              ) : a.en_cours ? (
                <span>
                  {a.en_cours}
                  {[0, 1, 2].map((k) => (
                    <span
                      key={k}
                      style={{
                        display: 'inline-block',
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        background: 'var(--color-accent-bright)',
                        marginLeft: 3,
                        animation: `v2-blink 1.2s ${k * 0.2}s infinite`,
                      }}
                    />
                  ))}
                </span>
              ) : (
                <span style={{ color: 'var(--color-text-muted)' }}>disponible</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <span
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 700,
                  background: 'var(--color-btn-bg)',
                  color: a.statut === 'observation' ? 'var(--color-warning)' : 'var(--color-status-success)',
                }}
              >
                {a.statut === 'observation' ? '👁 observation' : '● en service'}
              </span>
              {a.a_valider > 0 && <span style={{ color: 'var(--color-warning)', fontSize: 12 }}>🟠 {a.a_valider} à valider</span>}
            </div>
            <div style={{ display: 'flex', gap: 18, marginTop: 12, color: 'var(--color-text-muted)', fontSize: 12 }}>
              <div>
                <b style={{ color: 'var(--color-text)', fontSize: 16, display: 'block' }}>{a.faites_24h}</b>aujourd’hui
              </div>
              <div>
                <b style={{ color: 'var(--color-text)', fontSize: 16, display: 'block' }}>{a.faites_7j}</b>sur 7 jours
              </div>
            </div>
          </div>
        ))}
        {role === 'admin' && (
          <button
            type="button"
            onClick={() => onGo('equipe')}
            className="v2-hover-lift"
            style={{ ...card, borderStyle: 'dashed', background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 15 }}
          >
            ✨<br />
            Ajouter un agent
          </button>
        )}
      </div>

      <div style={h2}>À valider</div>
      <div style={card}>
        {vals.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>Rien à valider 🎉</div>}
        {vals.map((v) => {
          const a = byId[v.agent];
          return (
            <div key={v.id} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--color-border)' }}>
              {a && <Face a={{ ...a, en_cours: null }} size={40} />}
              <div style={{ flex: 1 }}>
                <b>{a?.prenom ?? v.agent}</b> demande : {v.action}
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                  {v.detail.length > 140 ? `${v.detail.slice(0, 140)}…` : v.detail} · valideur : {v.valideur || '—'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => decide(v, true)}
                style={{ border: 'none', borderRadius: 12, padding: '8px 14px', fontWeight: 700, background: 'var(--color-status-success)', color: 'var(--color-bg)', cursor: 'pointer' }}
              >
                ✓ Oui
              </button>
              <button
                type="button"
                onClick={() => decide(v, false)}
                style={{ border: '1px solid var(--color-danger)', borderRadius: 12, padding: '8px 14px', fontWeight: 700, background: 'transparent', color: 'var(--color-danger)', cursor: 'pointer' }}
              >
                Non
              </button>
            </div>
          );
        })}
      </div>

      <div style={h2}>💬 Demander quelque chose à un agent</div>
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAskTo(a.id)}
              style={{
                borderRadius: 999,
                padding: '6px 12px',
                cursor: 'pointer',
                border: '1px solid var(--color-border)',
                background: askTo === a.id ? 'var(--gradient-accent)' : 'var(--color-btn-bg)',
                color: askTo === a.id ? 'var(--color-on-accent)' : 'var(--color-text)',
                fontWeight: 600,
              }}
            >
              {a.emoji} {a.prenom}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            placeholder="Ex. « Peux-tu regarder pourquoi les numéros 9 ne remontent plus chez La Boîte Immo ? »"
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
          <button
            type="button"
            onClick={ask}
            disabled={!askText.trim()}
            style={{ border: 'none', borderRadius: 14, padding: '0 18px', fontWeight: 800, background: 'var(--gradient-accent)', color: 'var(--color-on-accent)', cursor: 'pointer' }}
          >
            Envoyer ✨
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
          La réponse arrive dans Missions (et bientôt directement dans Teams, comme avec un collègue).
        </div>
      </div>

      <div style={h2}>Dernières activités</div>
      <div style={card}>
        {(home?.recentes ?? []).map((m) => {
          const a = byId[m.agent];
          return (
            <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', fontSize: 13 }}>
              <span>{a?.emoji ?? '🤖'}</span>
              <span style={{ flex: 1 }}>
                <b>{a?.prenom ?? m.agent}</b> · {m.titre}
              </span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{m.maj_le.slice(5, 16).replace('-', '/')}</span>
            </div>
          );
        })}
      </div>

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--gradient-accent)',
            color: 'var(--color-on-accent)',
            fontWeight: 800,
            padding: '12px 18px',
            borderRadius: 14,
            zIndex: 400,
            boxShadow: 'var(--shadow-pixel)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
