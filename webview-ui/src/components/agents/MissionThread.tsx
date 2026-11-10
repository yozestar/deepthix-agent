// Conversation with an agent about one mission: what was asked, every answer
// of the agent, the human replies (with pasted / dropped images), and the
// pending validations (approve / refuse with a reason). Replying relaunches the
// agent on the SAME conversation (engine: --reprendre).
// Used inline by the CHAT space and as an overlay by the MISSIONS board.

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { bytesToBase64 } from '../../remote/upload';
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
interface Piece {
  nom: string;
  chemin: string;
  apercu?: string;
}

const EN_COURS = ['en_cours', 'demandee'];
const champ: React.CSSProperties = {
  flex: 1,
  resize: 'none',
  padding: 10,
  background: 'var(--color-bg-dark)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 12,
  fontFamily: 'var(--font-pixel)',
  fontSize: 13.5,
};

/** Composer: text + images (paste, drop, 📎). Enter sends, Shift+Enter = new line. */
export function AgentComposer({
  agent,
  placeholder,
  onSend,
  autoFocus,
}: {
  agent: string;
  placeholder: string;
  onSend: (texte: string, pieces: string[]) => Promise<void>;
  autoFocus?: boolean;
}): React.JSX.Element {
  const [texte, setTexte] = useState('');
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const fichier = useRef<HTMLInputElement>(null);

  const ajouter = async (files: File[]): Promise<void> => {
    for (const f of files) {
      try {
        const nom = f.name && f.name !== 'image.png' ? f.name : `capture_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const donnees = bytesToBase64(new Uint8Array(await f.arrayBuffer()));
        const r = await agentsApi<{ chemin: string; nom: string }>('piece_jointe', [agent], { nom, donnees });
        setPieces((p) => [...p, { nom: r.nom, chemin: r.chemin, apercu: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined }]);
      } catch (e) {
        setErreur(errMsg(e));
      }
    }
  };
  const envoyer = (): void => {
    if ((!texte.trim() && !pieces.length) || envoi) return;
    setEnvoi(true);
    onSend(texte.trim() || '(voir pièces jointes)', pieces.map((p) => p.chemin))
      .then(() => {
        setTexte('');
        setPieces([]);
        setErreur(null);
      })
      .catch((e) => setErreur(errMsg(e)))
      .finally(() => setEnvoi(false));
  };

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void ajouter(Array.from(e.dataTransfer.files));
      }}
      style={{ borderTop: '2px solid var(--color-border)', padding: 12 }}
    >
      {erreur && <div style={{ color: 'var(--color-danger)', fontSize: 12.5, marginBottom: 6 }}>⚠ {erreur}</div>}
      {pieces.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {pieces.map((p, i) => (
            <div key={p.chemin} style={{ position: 'relative', border: '1px solid var(--color-border)', borderRadius: 10, padding: 4, background: 'var(--color-bg-dark)' }}>
              {p.apercu ? (
                <img src={p.apercu} alt={p.nom} style={{ height: 64, borderRadius: 6, display: 'block' }} />
              ) : (
                <div style={{ fontSize: 12, padding: '18px 10px' }}>📎 {p.nom}</div>
              )}
              <button
                type="button"
                onClick={() => setPieces((x) => x.filter((_, j) => j !== i))}
                title="Retirer"
                style={{ position: 'absolute', top: -8, right: -8, border: 'none', borderRadius: 10, width: 20, height: 20, cursor: 'pointer', background: 'var(--color-danger)', color: 'var(--color-on-accent)' }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <button
          type="button"
          title="Joindre une image ou un fichier (vous pouvez aussi coller une capture ou glisser un fichier)"
          onClick={() => fichier.current?.click()}
          style={{ border: '1px solid var(--color-border)', background: 'var(--color-btn-bg)', borderRadius: 10, padding: '8px 10px', cursor: 'pointer', color: 'var(--color-text)' }}
        >
          📎
        </button>
        <input
          ref={fichier}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void ajouter(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <textarea
          autoFocus={autoFocus}
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void ajouter(Array.from(e.clipboardData.files));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              envoyer();
            }
          }}
          placeholder={placeholder}
          rows={Math.min(8, Math.max(2, texte.split('\n').length))}
          style={champ}
        />
        <Btn kind="primary" onClick={envoyer}>
          {envoi ? '…' : 'Envoyer'}
        </Btn>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>Entrée pour envoyer · Maj+Entrée pour aller à la ligne · collez une capture (Ctrl/⌘+V) ou glissez un fichier</div>
    </div>
  );
}

/** The conversation itself (no frame). */
export function MissionConversation({ missionId, compact }: { missionId: number; compact?: boolean }): React.JSX.Element {
  const [data, setData] = useState<Fil | null>(null);
  const [motifs, setMotifs] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
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
  useEffect(() => {
    bas.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.fil.length, enCours]);

  const decide = (v: Validation, d: 'accorder' | 'refuser'): void => {
    void agentsApi('valider', [String(v.id), d, 'relancer'], { motif: motifs[v.id] ?? '' })
      .then(() => refresh())
      .catch((e) => setError(errMsg(e)));
  };
  const pending = (data?.validations ?? []).filter((v) => v.statut === 'en_attente');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {error && <div style={{ padding: 10, background: 'var(--color-danger)', color: 'var(--color-on-accent)' }}>{error}</div>}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: compact ? 12 : 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
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
      {data && (
        <AgentComposer
          agent={data.mission.agent}
          placeholder={`Répondre à ${data.mission.agent}…`}
          onSend={async (texte, pieces) => {
            await agentsApi('repondre', [String(missionId)], { texte, pieces });
            await refresh();
          }}
        />
      )}
    </div>
  );
}

/** Overlay version (MISSIONS board). */
export function MissionThread({ missionId, onClose }: { missionId: number; onClose: () => void }): React.JSX.Element {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
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
          <div style={{ flex: 1, fontWeight: 800 }}>Mission #{missionId}</div>
          <Btn onClick={onClose}>✕</Btn>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <MissionConversation missionId={missionId} />
        </div>
      </div>
    </div>
  );
}
