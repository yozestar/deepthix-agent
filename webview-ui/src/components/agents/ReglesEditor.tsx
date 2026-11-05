// "Qui valide quoi" editor: one row per action type, three coloured toggle
// buttons (🟢 seul / 🟠 demande / 🔴 interdit), the approver picked from the
// team, add / remove rules, escalation and daily caps. Applied by the engine's
// guard (hook PreToolUse) — not by the model's goodwill.

import { useState } from 'react';

import { type Escalade, inputStyle, type Regle, RULE_META } from './model';
import { Btn, Card, Field } from './ui';

export interface Plafonds {
  actions_par_jour?: number;
  messages_teams_par_jour?: number;
  arret_apres_erreurs_consecutives?: number;
  missions_simultanees?: number;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);

export function ReglesEditor({
  regles,
  escalade,
  plafonds,
  personnes,
  busy,
  onSave,
}: {
  regles: Regle[];
  escalade: Escalade;
  plafonds: Plafonds;
  personnes: string[];
  busy: boolean;
  onSave: (r: Regle[], e: Escalade, p: Plafonds) => void;
}): React.JSX.Element {
  const [rs, setRs] = useState<Regle[]>(regles);
  const [esc, setEsc] = useState<Escalade>(escalade);
  const [pl, setPl] = useState<Plafonds>(plafonds);
  const [nouvelle, setNouvelle] = useState('');
  const upd = (i: number, patch: Partial<Regle>): void => setRs((x) => x.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Math.max(0, Number(v)));

  return (
    <Card
      title={`Qui valide quoi — ${rs.length} règles`}
      right={
        <Btn kind="primary" disabled={busy} onClick={() => onSave(rs, esc, pl)}>
          Enregistrer
        </Btn>
      }
    >
      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: 8 }}>
        Imposé par le garde-fou du moteur : 🟢 l'agent agit seul · 🟠 il attend l'accord de la personne choisie · 🔴 jamais, même si on le lui demande.
      </div>
      {rs.map((r, i) => (
        <div
          key={`${r.cle ?? 'r'}-${i}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 230px auto',
            gap: 8,
            alignItems: 'center',
            padding: '6px 0',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <input style={inputStyle} value={r.action} onChange={(e) => upd(i, { action: e.target.value })} />
          <div style={{ display: 'flex', gap: 4 }}>
            {(Object.keys(RULE_META) as Regle['regle'][]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => upd(i, { regle: k })}
                style={{
                  padding: '3px 8px',
                  fontFamily: 'var(--font-pixel)',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  border: `2px solid ${RULE_META[k].color}`,
                  background: r.regle === k ? RULE_META[k].color : 'transparent',
                  color: r.regle === k ? 'var(--color-on-accent)' : RULE_META[k].color,
                  boxShadow: r.regle === k ? 'var(--shadow-pixel)' : 'none',
                }}
              >
                {RULE_META[k].label}
              </button>
            ))}
          </div>
          {r.regle === 'demande' ? (
            <select style={inputStyle} value={r.valideur ?? ''} onChange={(e) => upd(i, { valideur: e.target.value })}>
              <option value="">— qui valide ? —</option>
              {[...new Set([...(r.valideur ? [r.valideur] : []), ...personnes])].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{r.regle === 'seul' ? 'aucune validation' : 'bloqué'}</span>
          )}
          <Btn title="Supprimer la règle" onClick={() => setRs((x) => x.filter((_, j) => j !== i))}>
            ✕
          </Btn>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input style={inputStyle} placeholder="Nouvelle règle : ex. « Envoyer un devis au client »" value={nouvelle} onChange={(e) => setNouvelle(e.target.value)} />
        <Btn
          disabled={!nouvelle.trim()}
          onClick={() => {
            setRs((x) => [...x, { action: nouvelle.trim(), regle: 'demande', cle: slug(nouvelle), valideur: '' }]);
            setNouvelle('');
          }}
        >
          + Ajouter
        </Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 14 }}>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: '0.8125rem' }}>⏱ Si personne ne répond</div>
          <Field label="Relancer après (min)">
            <input style={inputStyle} type="number" value={esc.relance_apres_min ?? ''} onChange={(e) => setEsc({ ...esc, relance_apres_min: num(e.target.value) })} />
          </Field>
          <Field label="Prévenir le responsable après (min)">
            <input
              style={inputStyle}
              type="number"
              value={esc.prevenir_responsable_apres_min ?? ''}
              onChange={(e) => setEsc({ ...esc, prevenir_responsable_apres_min: num(e.target.value) })}
            />
          </Field>
          <Field label="Puis prévenir">
            <select style={inputStyle} value={esc.puis ?? ''} onChange={(e) => setEsc({ ...esc, puis: e.target.value })}>
              {[...new Set([...(esc.puis ? [esc.puis] : []), ...personnes])].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>L'agent ne passe jamais outre une validation.</div>
        </div>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: '0.8125rem' }}>🛑 Limites de sécurité</div>
          <Field label="Actions max par jour">
            <input style={inputStyle} type="number" value={pl.actions_par_jour ?? ''} onChange={(e) => setPl({ ...pl, actions_par_jour: num(e.target.value) })} />
          </Field>
          <Field label="Messages Teams max par jour">
            <input
              style={inputStyle}
              type="number"
              value={pl.messages_teams_par_jour ?? ''}
              onChange={(e) => setPl({ ...pl, messages_teams_par_jour: num(e.target.value) })}
            />
          </Field>
          <Field label="Arrêt après N erreurs de suite">
            <input
              style={inputStyle}
              type="number"
              value={pl.arret_apres_erreurs_consecutives ?? ''}
              onChange={(e) => setPl({ ...pl, arret_apres_erreurs_consecutives: num(e.target.value) })}
            />
          </Field>
        </div>
      </div>
    </Card>
  );
}
