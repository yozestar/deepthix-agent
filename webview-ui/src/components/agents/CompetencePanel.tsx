// One skill, opened from SAVOIR: read it, edit it (versioned, with a reason),
// see its history, and accept / refuse the improvements proposed by agents.

import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { agentsApi } from '../../tauri/commands';
import { errMsg } from './model';
import { Btn } from './ui';

interface Proposition {
  id: string;
  agent: string;
  motif: string;
  quand: string;
  texte: string;
}
interface Detail {
  nom: string;
  texte: string;
  agents: string[];
  modifiable: boolean;
  historique: { commit: string; date: string; auteur: string; message: string }[];
  propositions: Proposition[];
}

const sansEntete = (t: string): string => t.replace(/^---[\s\S]*?---\s*/, '');
const champ: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--color-bg-dark)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  padding: 10,
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
};

export function CompetencePanel({ nom, onClose, onChange }: { nom: string; onClose: () => void; onChange: () => void }): React.JSX.Element {
  const [d, setD] = useState<Detail | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [motif, setMotif] = useState('');
  const [voir, setVoir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setD(await agentsApi<Detail>('competence_lire', [nom]));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [nom]);
  useEffect(() => void refresh(), [refresh]);

  const fait = (m: string): void => {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
    onChange();
    void refresh();
  };
  const enregistrer = (): void => {
    if (edit === null) return;
    void agentsApi('competence_maj', [nom], { texte: edit, motif })
      .then(() => {
        setEdit(null);
        setMotif('');
        fait('✓ Compétence enregistrée (versionnée)');
      })
      .catch((e) => setError(errMsg(e)));
  };
  const decider = (p: Proposition, dec: 'accepter' | 'refuser'): void => {
    void agentsApi('proposition_decider', [nom, p.id, dec], {})
      .then(() => fait(dec === 'accepter' ? '✓ Proposition appliquée' : 'Proposition refusée'))
      .catch((e) => setError(errMsg(e)));
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="v2-fade"
        style={{
          width: 'min(860px, 100%)',
          height: '100%',
          background: 'var(--color-bg)',
          borderLeft: '2px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-pixel)',
          color: 'var(--color-text)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '2px solid var(--color-border)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800 }}>🧠 {nom}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              Utilisée par : {d?.agents.length ? d.agents.join(', ') : 'aucun agent'}
            </div>
          </div>
          {d?.modifiable && edit === null && <Btn onClick={() => setEdit(d.texte)}>✏️ Modifier</Btn>}
          <Btn onClick={onClose}>✕</Btn>
        </div>
        {error && <div style={{ padding: 10, background: 'var(--color-danger)', color: 'var(--color-on-accent)' }}>{error}</div>}
        {toast && <div style={{ padding: 8, background: 'var(--color-status-success)', color: 'var(--color-bg)' }}>{toast}</div>}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
          {(d?.propositions ?? []).map((p) => (
            <div key={p.id} style={{ border: '2px solid var(--color-warning)', borderRadius: 14, padding: 12, marginBottom: 14 }}>
              <div style={{ fontWeight: 700 }}>
                💡 Proposition de {p.agent} · {p.quand}
              </div>
              <div style={{ fontSize: 13, margin: '4px 0 8px' }}>{p.motif}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn onClick={() => setVoir(voir === p.id ? null : p.id)}>{voir === p.id ? 'Masquer' : 'Voir la nouvelle version'}</Btn>
                {d?.modifiable && (
                  <>
                    <Btn kind="success" onClick={() => decider(p, 'accepter')}>
                      ✓ Accepter
                    </Btn>
                    <Btn kind="danger" onClick={() => decider(p, 'refuser')}>
                      ✕ Refuser
                    </Btn>
                  </>
                )}
              </div>
              {voir === p.id && (
                <div style={{ marginTop: 10, padding: 10, background: 'var(--color-bg-dark)', borderRadius: 10 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{sansEntete(p.texte)}</ReactMarkdown>
                </div>
              )}
            </div>
          ))}
          {edit !== null ? (
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                Garde l’en-tête (entre les deux lignes ---). Décris les actions pas à pas, avec les commandes exactes : l’agent suit ce texte à la lettre.
              </div>
              <textarea value={edit} onChange={(e) => setEdit(e.target.value)} rows={26} style={{ ...champ, resize: 'vertical' }} />
              <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Pourquoi ce changement ? (gardé dans l’historique)" style={{ ...champ, fontFamily: 'var(--font-pixel)', marginTop: 8 }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Btn kind="primary" onClick={enregistrer}>
                  Enregistrer
                </Btn>
                <Btn onClick={() => setEdit(null)}>Annuler</Btn>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{sansEntete(d?.texte ?? '')}</ReactMarkdown>
            </div>
          )}
          {(d?.historique.length ?? 0) > 0 && (
            <div style={{ marginTop: 22 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>🕓 Historique</div>
              {d?.historique.map((h) => (
                <div key={h.commit} style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '3px 0' }}>
                  {h.date} · {h.auteur} — {h.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
