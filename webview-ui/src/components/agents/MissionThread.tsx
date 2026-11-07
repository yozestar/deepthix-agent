// Conversation of one mission: what was asked, every answer of the agent, the
// human replies, and the pending validations (approve / refuse with a reason).
// Replying relaunches the agent on the SAME conversation (engine: --reprendre).

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { agentsApi } from '../../tauri/commands';
import { errMsg, type Validation } from './model';
import { Btn } from './ui';

interface Bulle {
  type: 'humain' | 'agent';
  auteur: string;
  quand: string;
  texte: string;
  statut?: string;
}
interface Fil {
  mission: { id: number; agent: string; titre: string; demandeur: string; statut: string };
  fil: Bulle[];
  validations: Validation[];
}

const EN_COURS = ['en_cours', 'demandee'];

export function MissionThread({ missionId, onClose }: { missionId: number; onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<Fil | null>(null);
  const [texte, setTexte] = useState('');
  const [motifs, setMotifs] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const bas = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setData(await agentsApi<Fil>('fil', [String(missionId)]));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [missionId]);

  const enCours = !!data && EN_COURS.includes(data.mission.statut);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), enCours ? 4000 : 15000);
    return () => clearInterval(t);
  }, [refresh, enCours]);
  useEffect(() => bas.current?.scrollIntoView({ behavior: 'smooth' }), [data?.fil.length, enCours]);

  const repondre = (): void => {
    if (!texte.trim()) return;
    setEnvoi(true);
    void agentsApi('repondre', [String(missionId)], { texte: texte.trim() })
      .then(() => {
        setTexte('');
        return refresh();
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setEnvoi(false));
  };
  const decide = (v: Validation, d: 'accorder' | 'refuser'): void => {
    void agentsApi('valider', [String(v.id), d, 'relancer'], { motif: motifs[v.id] ?? '' })
      .then(() => refresh())
      .catch((e) => setError(errMsg(e)));
  };

  const pending = (data?.validations ?? []).filter((v) => v.statut === 'en_attente');
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="v2-fade"
        style={{
          width: 'min(760px, 100%)',
          height: '100%',
          background: 'var(--color-bg)',
          borderLeft: '2px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-pixel)',
          color: 'var(--color-text)',
        }}
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 16px', borderBottom: '2px solid var(--color-border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800 }}>
              #{missionId} · {data?.mission.agent ?? '…'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {data?.mission.titre}
            </div>
          </div>
          <Btn onClick={onClose}>✕</Btn>
        </div>
        {error && <div style={{ padding: 10, background: 'var(--color-danger)', color: 'var(--color-on-accent)' }}>{error}</div>}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(data?.fil ?? []).map((b, i) => {
            const moi = b.type === 'humain';
            return (
              <div key={i} style={{ alignSelf: moi ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
                <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', margin: moi ? '0 6px 3px 0' : '0 0 3px 6px', textAlign: moi ? 'right' : 'left' }}>
                  {moi ? b.auteur : `🤖 ${b.auteur}`} · {b.quand}
                  {b.statut === 'erreur' && ' · ⚠ erreur'}
                </div>
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: 16,
                    background: moi ? 'var(--color-active-bg)' : 'var(--color-bg-dark)',
                    border: '1px solid var(--color-border)',
                    fontSize: 13.5,
                    lineHeight: 1.45,
                    overflowX: 'auto',
                  }}
                >
                  {moi ? <div style={{ whiteSpace: 'pre-wrap' }}>{b.texte}</div> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{b.texte || '(pas de réponse)'}</ReactMarkdown>}
                </div>
              </div>
            );
          })}
          {enCours && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>⏳ {data?.mission.agent} travaille…</div>}
          {pending.map((v) => (
            <div key={v.id} style={{ border: '2px solid var(--color-warning)', borderRadius: 14, padding: 12 }}>
              <div style={{ fontWeight: 700 }}>🟠 {v.agent} demande ton accord : {v.action}</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'var(--font-mono)', margin: '6px 0', color: 'var(--color-text-muted)' }}>{v.detail}</pre>
              <input
                placeholder="Motif ou consigne (facultatif) — ex. « pas avant 19 h »"
                value={motifs[v.id] ?? ''}
                onChange={(e) => setMotifs((m) => ({ ...m, [v.id]: e.target.value }))}
                style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginBottom: 8, background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)', borderRadius: 8 }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn kind="success" onClick={() => decide(v, 'accorder')}>
                  ✓ Valider
                </Btn>
                <Btn kind="danger" onClick={() => decide(v, 'refuser')}>
                  ✕ Refuser
                </Btn>
              </div>
            </div>
          ))}
          <div ref={bas} />
        </div>
        <div style={{ borderTop: '2px solid var(--color-border)', padding: 12, display: 'flex', gap: 8 }}>
          <textarea
            value={texte}
            onChange={(e) => setTexte(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) repondre();
            }}
            placeholder={`Répondre à ${data?.mission.agent ?? 'l’agent'}… (⌘ + Entrée pour envoyer)`}
            rows={3}
            style={{ flex: 1, resize: 'vertical', padding: 8, background: 'var(--color-bg-dark)', color: 'var(--color-text)', border: '1px solid var(--color-border)', borderRadius: 10, fontFamily: 'var(--font-pixel)', fontSize: 13.5 }}
          />
          <Btn kind="primary" onClick={repondre}>
            {envoi ? '…' : 'Envoyer'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
