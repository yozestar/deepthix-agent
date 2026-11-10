// UTILISATEURS (Équipe, administrateurs seulement): the team members, their
// profile (administrateur / responsable de pôle / collaborateur), their pole,
// the agents they may ask, and whether they can connect. Stored on the Mac
// mini (utilisateurs.json) and enforced by the engine on every action.

import { useCallback, useEffect, useState } from 'react';

import { agentsApi } from '../../tauri/commands';
import { type Catalogue, DomainesPicker } from './ConnexionsView';
import { type AgentSummary, errMsg } from './model';

interface Utilisateur {
  email: string;
  nom: string;
  profil: 'admin' | 'responsable' | 'collaborateur';
  pole: string;
  agents_autorises: string[] | '*';
  actif: boolean;
  /** Domaines de données par application ; absent = valeurs par défaut du profil. */
  domaines?: Record<string, string[] | '*'>;
}

const PROFILS: ReadonlyArray<{ id: Utilisateur['profil']; label: string; aide: string }> = [
  { id: 'admin', label: '👑 Administrateur', aide: 'Tout : agents, règles, comptes, utilisateurs' },
  { id: 'responsable', label: '🧭 Responsable de pôle', aide: 'Gère les agents de son pôle et leurs validations' },
  { id: 'collaborateur', label: '🙂 Collaborateur', aide: 'Accueil, ses validations, demander aux agents autorisés' },
];
const VIDE: Utilisateur = { email: '', nom: '', profil: 'collaborateur', pole: '', agents_autorises: [], actif: true };

const field: React.CSSProperties = {
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 12,
  padding: '8px 10px',
  color: 'var(--color-text)',
  width: '100%',
};

export function UtilisateursView({ agents, onChanged, onError }: { agents: AgentSummary[]; onChanged: (m: string) => void; onError: (m: string) => void }): React.JSX.Element {
  const [users, setUsers] = useState<Utilisateur[]>([]);
  const [edit, setEdit] = useState<Utilisateur | null>(null);
  const [cat, setCat] = useState<Catalogue | null>(null);
  useEffect(() => {
    void agentsApi<Catalogue>('domaines_catalogue').then(setCat).catch(() => undefined);
  }, []);
  const poles = [...new Set([...agents.map((a) => a.pole ?? ''), ...users.map((u) => u.pole)].filter(Boolean))];

  const load = useCallback(async () => {
    try {
      setUsers(await agentsApi<Utilisateur[]>('utilisateurs'));
    } catch (e) {
      onError(errMsg(e));
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = (u: Utilisateur): void => {
    void agentsApi('maj_utilisateur', [], u)
      .then(() => {
        onChanged(`${u.nom || u.email} enregistré`);
        setEdit(null);
        return load();
      })
      .catch((e) => onError(errMsg(e)));
  };
  const toggleActif = (u: Utilisateur): void => save({ ...u, actif: !u.actif });
  const remove = (u: Utilisateur): void => {
    void agentsApi('suppr_utilisateur', [u.email])
      .then(() => {
        onChanged(`${u.nom || u.email} supprimé`);
        return load();
      })
      .catch((e) => onError(errMsg(e)));
  };
  const agentsDe = (u: Utilisateur): string =>
    u.agents_autorises === '*' ? 'tous les agents' : u.agents_autorises.map((id) => agents.find((a) => a.id === id)?.prenom ?? id).join(', ') || 'aucun agent';

  return (
    <div className="v2-fade">
      <div style={{ color: 'var(--color-text-muted)', marginBottom: 14, fontSize: 13 }}>
        Chaque collègue travaille sur son propre poste avec sa licence Claude, et vient chercher ici ses droits sur les agents. Seules les personnes{' '}
        <b>actives</b> peuvent se connecter au Mac mini (avec leur compte Microsoft Elyone).
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {users.map((u) => (
          <div
            key={u.email}
            className="v2-hover-lift"
            style={{
              background: 'var(--color-bg-dark)',
              border: '1px solid var(--color-border)',
              borderRadius: 18,
              padding: 14,
              boxShadow: 'var(--shadow-pixel)',
              opacity: u.actif ? 1 : 0.6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 14,
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: 800,
                  background: u.profil === 'admin' ? 'var(--gradient-accent)' : 'var(--color-btn-hover)',
                  color: 'var(--color-on-accent)',
                }}
              >
                {(u.nom || u.email).slice(0, 1).toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800 }}>{u.nom || u.email}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{u.email}</div>
              </div>
              <button
                type="button"
                onClick={() => toggleActif(u)}
                title={u.actif ? 'Désactiver (ne peut plus se connecter)' : 'Activer'}
                style={{
                  border: 'none',
                  borderRadius: 999,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontWeight: 700,
                  fontSize: 12,
                  background: u.actif ? 'var(--color-status-success)' : 'var(--color-btn-bg)',
                  color: u.actif ? 'var(--color-bg)' : 'var(--color-text-muted)',
                }}
              >
                {u.actif ? '● actif' : '○ inactif'}
              </button>
            </div>
            <div style={{ fontSize: 13, marginTop: 10 }}>
              {PROFILS.find((p) => p.id === u.profil)?.label} · {u.pole || 'sans pôle'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>Peut demander à : {agentsDe(u)}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" onClick={() => setEdit(u)} style={{ ...field, width: 'auto', cursor: 'pointer' }}>
                ✏️ Modifier
              </button>
              <button type="button" onClick={() => remove(u)} style={{ ...field, width: 'auto', cursor: 'pointer', color: 'var(--color-danger)' }}>
                Supprimer
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setEdit({ ...VIDE })}
          className="v2-hover-lift"
          style={{ borderRadius: 18, border: '1.5px dashed var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer', minHeight: 140, fontSize: 15 }}
        >
          ＋ Ajouter un collègue
        </button>
      </div>

      {edit && (
        <div
          onClick={() => setEdit(null)}
          style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop)', display: 'grid', placeItems: 'center', zIndex: 300 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="v2-fade"
            style={{ width: 'min(560px, 92vw)', background: 'var(--color-bg-dark)', border: '1px solid var(--color-border)', borderRadius: 22, padding: 20, boxShadow: 'var(--shadow-pixel)' }}
          >
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 12 }}>{edit.email ? `Modifier ${edit.nom || edit.email}` : 'Ajouter un collègue'}</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <input style={field} placeholder="Prénom Nom" value={edit.nom} onChange={(e) => setEdit({ ...edit, nom: e.target.value })} />
              <input style={field} placeholder="adresse@elyone.com (son compte Microsoft)" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
              <div style={{ display: 'grid', gap: 6 }}>
                {PROFILS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setEdit({ ...edit, profil: p.id })}
                    style={{
                      textAlign: 'left',
                      borderRadius: 14,
                      padding: '10px 12px',
                      cursor: 'pointer',
                      border: `1px solid ${edit.profil === p.id ? 'var(--color-accent-bright)' : 'var(--color-border)'}`,
                      background: edit.profil === p.id ? 'var(--color-active-bg)' : 'transparent',
                      color: 'var(--color-text)',
                    }}
                  >
                    <b>{p.label}</b>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{p.aide}</div>
                  </button>
                ))}
              </div>
              <input style={field} list="poles-elyone" placeholder="Pôle (ex. Support client)" value={edit.pole} onChange={(e) => setEdit({ ...edit, pole: e.target.value })} />
              <datalist id="poles-elyone">
                {poles.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              <div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6 }}>Agents à qui il peut demander quelque chose</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => setEdit({ ...edit, agents_autorises: edit.agents_autorises === '*' ? [] : '*' })}
                    style={{
                      borderRadius: 999,
                      padding: '6px 12px',
                      cursor: 'pointer',
                      border: '1px solid var(--color-border)',
                      background: edit.agents_autorises === '*' ? 'var(--gradient-accent)' : 'var(--color-btn-bg)',
                      color: edit.agents_autorises === '*' ? 'var(--color-on-accent)' : 'var(--color-text)',
                    }}
                  >
                    Tous
                  </button>
                  {agents.map((a) => {
                    const on = edit.agents_autorises === '*' || edit.agents_autorises.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        disabled={edit.agents_autorises === '*'}
                        onClick={() => {
                          const cur = edit.agents_autorises === '*' ? [] : edit.agents_autorises;
                          setEdit({ ...edit, agents_autorises: on ? cur.filter((x) => x !== a.id) : [...cur, a.id] });
                        }}
                        style={{
                          borderRadius: 999,
                          padding: '6px 12px',
                          cursor: 'pointer',
                          border: '1px solid var(--color-border)',
                          background: on ? 'var(--color-active-bg)' : 'var(--color-btn-bg)',
                          color: 'var(--color-text)',
                        }}
                      >
                        {a.emoji ?? '🤖'} {a.prenom}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            {cat && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontWeight: 700 }}>🔐 Domaines de données (ce que les agents peuvent lui montrer)</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '2px 0 8px' }}>
                  Par défaut : selon le profil. « Mon travail » = uniquement ses propres tâches, temps et tickets. Comptabilité séparée par journaux.
                </div>
                {Object.entries(cat.apps).map(([app, doms]) => {
                  const perso = edit.domaines?.[app];
                  const defaut = cat.profils_par_defaut[edit.profil]?.[app] ?? [];
                  return (
                    <div key={app} style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
                        <b style={{ textTransform: 'capitalize' }}>{app}</b>
                        <label style={{ fontSize: 12.5 }}>
                          <input
                            type="checkbox"
                            checked={perso === undefined}
                            onChange={() => {
                              const d = { ...(edit.domaines ?? {}) };
                              if (perso === undefined) d[app] = defaut;
                              else delete d[app];
                              setEdit({ ...edit, domaines: d });
                            }}
                          />{' '}
                          selon le profil
                        </label>
                      </div>
                      <DomainesPicker
                        domaines={doms}
                        value={perso ?? defaut}
                        onChange={(v) => setEdit({ ...edit, domaines: { ...(edit.domaines ?? {}), [app]: v } })}
                        toutLibelle="Tous les domaines"
                      />
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={() => setEdit(null)} style={{ ...field, width: 'auto', cursor: 'pointer' }}>
                Annuler
              </button>
              <button
                type="button"
                disabled={!edit.email.includes('@')}
                onClick={() => save(edit)}
                style={{ border: 'none', borderRadius: 12, padding: '8px 18px', fontWeight: 800, background: 'var(--gradient-accent)', color: 'var(--color-on-accent)', cursor: 'pointer' }}
              >
                Enregistrer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
