// ÉQUIPE → 🔌 Connexions : qui (agent) accède à quelle application (Odoo, HubSpot…),
// avec quelle fiche Passbolt, quels droits, et quel périmètre de données.
// La personne qui demande ne voit jamais que l'intersection périmètre ∩ ses domaines
// (réglés dans Utilisateurs et droits).

import { useCallback, useEffect, useMemo, useState } from 'react';

import { agentsApi } from '../../tauri/commands';
import { type AgentSummary, errMsg } from './model';
import { Btn, Card } from './ui';

export interface Catalogue {
  apps: Record<string, Record<string, { libelle: string; groupe: string }>>;
  profils_par_defaut: Record<string, Record<string, string[] | '*'>>;
}
interface Connexion {
  id: string;
  app: 'odoo' | 'hubspot';
  nom: string;
  methode: 'api' | 'navigateur';
  fiche: string;
  url?: string;
  base?: string;
  journaux_paie?: string[];
  perimetre: string[] | '*';
  agents: Record<string, { droits: Droit }>;
}
type Droit = 'lecture' | 'ecriture_validee' | 'ecriture';
const DROITS: ReadonlyArray<{ id: Droit | ''; label: string }> = [
  { id: '', label: '— pas d’accès' },
  { id: 'lecture', label: '👁 Lecture' },
  { id: 'ecriture_validee', label: '✏️ Écriture avec validation 🟠' },
  { id: 'ecriture', label: '✏️ Écriture libre 🟢' },
];
const APPS: Record<string, string> = { odoo: 'Odoo', hubspot: 'HubSpot' };
const VIDE: Connexion = { id: '', app: 'odoo', nom: '', methode: 'api', fiche: '', url: '', base: '', journaux_paie: [], perimetre: '*', agents: {} };
const champ: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 9px',
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  fontFamily: 'var(--font-pixel)',
  fontSize: 13,
  marginTop: 4,
};

/** Cases à cocher des domaines de données d'une application, regroupés. value '*' = tout. */
export function DomainesPicker({
  domaines,
  value,
  onChange,
  toutLibelle = 'Tout',
}: {
  domaines: Record<string, { libelle: string; groupe: string }>;
  value: string[] | '*';
  onChange: (v: string[] | '*') => void;
  toutLibelle?: string;
}): React.JSX.Element {
  const groupes = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const [k, d] of Object.entries(domaines)) (g[d.groupe || 'Autres'] ??= []).push(k);
    return g;
  }, [domaines]);
  const tout = value === '*';
  return (
    <div>
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 700, marginBottom: 6 }}>
        <input type="checkbox" checked={tout} onChange={() => onChange(tout ? [] : '*')} /> {toutLibelle}
      </label>
      {!tout && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
          {Object.entries(groupes).map(([g, ks]) => (
            <div key={g}>
              <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>{g}</div>
              {ks.map((k) => (
                <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12.5, margin: '2px 0' }}>
                  <input
                    type="checkbox"
                    checked={value.includes(k)}
                    onChange={() => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])}
                  />
                  {domaines[k].libelle}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConnexionsView({ agents, onChanged, onError }: { agents: AgentSummary[]; onChanged: (m: string) => void; onError: (m: string) => void }): React.JSX.Element {
  const [liste, setListe] = useState<Connexion[]>([]);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [fiches, setFiches] = useState<{ nom: string; comptes: string[] }[]>([]);
  const [edit, setEdit] = useState<Connexion | null>(null);
  const [test, setTest] = useState<Record<string, string>>({});

  const charger = useCallback(async (): Promise<void> => {
    try {
      const [l, c] = await Promise.all([agentsApi<Connexion[]>('connexions_liste'), agentsApi<Catalogue>('domaines_catalogue')]);
      setListe(l);
      setCat(c);
    } catch (e) {
      onError(errMsg(e));
    }
  }, [onError]);
  useEffect(() => void charger(), [charger]);
  useEffect(() => {
    if (edit && !fiches.length) void agentsApi<{ nom: string; comptes: string[] }[]>('fiches_passbolt').then(setFiches).catch((e) => onError(errMsg(e)));
  }, [edit, fiches.length, onError]);

  const enregistrer = (): void => {
    if (!edit) return;
    void agentsApi('connexion_maj', [], edit)
      .then(() => {
        onChanged('✓ Connexion enregistrée');
        setEdit(null);
        return charger();
      })
      .catch((e) => onError(errMsg(e)));
  };
  const tester = (id: string): void => {
    setTest((t) => ({ ...t, [id]: '⏳ test en cours…' }));
    void agentsApi<{ ok: boolean; message: string }>('connexion_tester', [id])
      .then((r) => setTest((t) => ({ ...t, [id]: (r.ok ? '✅ ' : '❌ ') + r.message })))
      .catch((e) => setTest((t) => ({ ...t, [id]: '❌ ' + errMsg(e) })));
  };
  const nomAgent = (id: string): string => {
    const a = agents.find((x) => x.id === id);
    return a ? `${a.emoji ?? '🤖'} ${a.prenom}` : id;
  };

  if (edit && cat)
    return (
      <Card title={edit.id && liste.some((x) => x.id === edit.id) ? `Modifier « ${edit.nom || edit.id} »` : 'Nouvelle connexion'}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, fontSize: 13 }}>
          <label>
            Application
            <select style={champ} value={edit.app} onChange={(e) => setEdit({ ...edit, app: e.target.value as Connexion['app'], perimetre: '*' })}>
              {Object.entries(APPS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Nom affiché
            <input style={champ} value={edit.nom} placeholder="ex. Odoo Vizzia (production)" onChange={(e) => setEdit({ ...edit, nom: e.target.value })} />
          </label>
          <label>
            Identifiant (court)
            <input style={champ} value={edit.id} placeholder="ex. odoo-vizzia" onChange={(e) => setEdit({ ...edit, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
          </label>
          <label>
            Méthode
            <select style={champ} value={edit.methode} onChange={(e) => setEdit({ ...edit, methode: e.target.value as Connexion['methode'] })}>
              <option value="api">🔑 Clé API (données)</option>
              <option value="navigateur">🌐 Identifiant + mot de passe (navigateur, captures)</option>
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            Fiche Passbolt (le secret n’est jamais visible des agents)
            <input style={champ} list="fiches-passbolt" value={edit.fiche} placeholder="tape pour chercher…" onChange={(e) => setEdit({ ...edit, fiche: e.target.value })} />
            <datalist id="fiches-passbolt">
              {fiches.map((f) => (
                <option key={f.nom} value={f.nom}>
                  {`partagée avec : ${f.comptes.join(', ')}`}
                </option>
              ))}
            </datalist>
          </label>
          {edit.app === 'odoo' && (
            <>
              <label>
                Adresse Odoo
                <input style={champ} value={edit.url ?? ''} placeholder="https://client.odoo.com" onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
              </label>
              <label>
                Base de données
                <input style={champ} value={edit.base ?? ''} placeholder="nom de la base" onChange={(e) => setEdit({ ...edit, base: e.target.value })} />
              </label>
              <label>
                Codes des journaux de paie (séparés par des virgules)
                <input
                  style={champ}
                  value={(edit.journaux_paie ?? []).join(', ')}
                  placeholder="ex. PAY, SAL"
                  onChange={(e) => setEdit({ ...edit, journaux_paie: e.target.value.split(',').map((x) => x.trim()) })}
                />
              </label>
            </>
          )}
        </div>
        <div style={{ marginTop: 16, fontWeight: 700 }}>Agents et droits</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 8, marginTop: 6 }}>
          {agents.map((a) => (
            <label key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <span style={{ width: 90, flex: 'none' }}>{nomAgent(a.id)}</span>
              <select
                style={{ ...champ, width: 'auto', flex: 1, minWidth: 0, marginTop: 0 }}
                value={edit.agents[a.id]?.droits ?? ''}
                onChange={(e) => {
                  const ag = { ...edit.agents };
                  if (e.target.value) ag[a.id] = { droits: e.target.value as Droit };
                  else delete ag[a.id];
                  setEdit({ ...edit, agents: ag });
                }}
              >
                {DROITS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <div style={{ marginTop: 16, fontWeight: 700 }}>Périmètre de la connexion (le maximum ouvert ; chaque personne n’en voit que ses propres domaines)</div>
        <div style={{ marginTop: 6 }}>
          <DomainesPicker domaines={cat.apps[edit.app] ?? {}} value={edit.perimetre} onChange={(v) => setEdit({ ...edit, perimetre: v })} toutLibelle="Tous les domaines" />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Btn kind="primary" onClick={enregistrer}>
            Enregistrer
          </Btn>
          <Btn onClick={() => setEdit(null)}>Annuler</Btn>
        </div>
      </Card>
    );

  return (
    <div>
      <div style={{ color: 'var(--color-text-muted)', marginBottom: 12, fontSize: 13 }}>
        Une connexion = un agent accède à une application, avec une fiche Passbolt et des droits. La personne qui parle à l’agent ne voit que ses propres domaines de
        données (réglés dans <b>Utilisateurs et droits</b>) : la comptabilité est séparée par journaux (ventes, achats, banque, OD, paie).
      </div>
      <Btn kind="primary" onClick={() => setEdit({ ...VIDE, agents: {} })}>
        ＋ Nouvelle connexion
      </Btn>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, marginTop: 14 }}>
        {liste.map((c) => (
          <Card key={c.id} title={`🔌 ${c.nom || c.id}`}>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
              {APPS[c.app]} · {c.methode === 'api' ? '🔑 clé API' : '🌐 navigateur'} · <code>{c.id}</code>
            </div>
            <div style={{ fontSize: 12.5, marginTop: 6 }}>Fiche : {c.fiche}</div>
            <div style={{ fontSize: 12.5, marginTop: 6 }}>
              Périmètre : {c.perimetre === '*' ? 'tous les domaines' : c.perimetre.map((d) => cat?.apps[c.app]?.[d]?.libelle ?? d).join(', ') || 'aucun'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {Object.entries(c.agents).map(([id, v]) => (
                <span key={id} style={{ fontSize: 12, padding: '3px 9px', borderRadius: 999, background: 'var(--color-btn-bg)' }}>
                  {nomAgent(id)} · {DROITS.find((d) => d.id === v.droits)?.label ?? v.droits}
                </span>
              ))}
              {!Object.keys(c.agents).length && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>aucun agent</span>}
            </div>
            {test[c.id] && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, marginTop: 8, maxHeight: 160, overflow: 'auto' }}>{test[c.id]}</pre>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Btn onClick={() => setEdit(JSON.parse(JSON.stringify(c)) as Connexion)}>✏️ Modifier</Btn>
              <Btn onClick={() => tester(c.id)}>🧪 Tester</Btn>
              <Btn
                kind="danger"
                onClick={() =>
                  void agentsApi('connexion_suppr', [c.id])
                    .then(() => charger())
                    .catch((e) => onError(errMsg(e)))
                }
              >
                Supprimer
              </Btn>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
