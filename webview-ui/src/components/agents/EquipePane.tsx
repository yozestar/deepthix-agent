// ÉQUIPE tab: organigramme, agent sheets (identity, Claude account, skills,
// rules, job description, history with revert), Claude accounts and the
// "new agent" wizard. Every change goes through the engine, which versions
// the configuration in elyone-lab/agents-config.

import { useCallback, useEffect, useState } from 'react';

import { agentsApi } from '../../tauri/commands';
import { AccesEditor, type Outil } from './AccesEditor';
import {
  type AgentDetail,
  type AgentSummary,
  type Commit,
  type Competence,
  type Compte,
  errMsg,
  inputStyle,
  paneStyle,
  type Pole,
  type Regle,
} from './model';
import { Organigramme } from './Organigramme';
import { ReglesEditor } from './ReglesEditor';
import { Avatar, Btn, Card, Chip, Field } from './ui';

export type View = 'organigramme' | 'agents' | 'comptes' | 'nouveau';
const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'organigramme', label: 'Organigramme' },
  { id: 'agents', label: 'Fiches des agents' },
  { id: 'comptes', label: 'Comptes Claude' },
  { id: 'nouveau', label: '+ Nouvel agent' },
];

export function EquipePane({ initialView = 'organigramme' }: { initialView?: View } = {}): React.JSX.Element {
  const [view, setView] = useState<View>(initialView);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [poles, setPoles] = useState<Pole[]>([]);
  const [comptes, setComptes] = useState<Compte[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const st = await agentsApi<{ agents: AgentSummary[]; poles: Pole[] }>('etat');
      setAgents(st.agents);
      setPoles(st.poles);
      setComptes(await agentsApi<Compte[]>('comptes'));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const notify = (m: string): void => {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  };
  const openAgent = (id: string): void => {
    setSelected(id);
    setView('agents');
  };

  return (
    <div style={paneStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
        }}
      >
        <span style={{ color: 'var(--color-accent)', fontWeight: 700, marginRight: 12 }}>ÉQUIPE</span>
        {VIEWS.map((v) => (
          <Btn key={v.id} kind={view === v.id ? 'primary' : 'normal'} onClick={() => setView(v.id)}>
            {v.label}
          </Btn>
        ))}
        <span style={{ flex: 1 }} />
        {toast && <span style={{ color: 'var(--color-status-success)', fontSize: '0.8125rem' }}>{toast}</span>}
      </div>
      {error && (
        <div style={{ padding: 10, background: 'var(--color-danger)', color: 'var(--color-on-accent)' }}>{error}</div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
        {view === 'organigramme' && (
          <Organigramme
            poles={poles}
            agents={agents}
            onOpen={openAgent}
            onNew={() => setView('nouveau')}
            onMove={(id, pole, responsable) =>
              void agentsApi('maj_agent', [id], { agent: { pole, responsable } })
                .then(() => {
                  notify(`${agents.find((a) => a.id === id)?.prenom ?? id} rejoint ${responsable || pole} ✨`);
                  return refresh();
                })
                .catch((e) => setError(errMsg(e)))
            }
          />
        )}
        {view === 'agents' && (
          <AgentsView
            agents={agents}
            comptes={comptes}
            selected={selected ?? agents[0]?.id ?? null}
            onSelect={setSelected}
            onChanged={(m) => {
              notify(m);
              void refresh();
            }}
            onError={setError}
          />
        )}
        {view === 'comptes' && <ComptesView comptes={comptes} onChanged={() => void refresh()} onError={setError} />}
        {view === 'nouveau' && (
          <NouvelAgent
            agents={agents}
            comptes={comptes}
            onCreated={(id) => {
              notify('Agent créé (mode observation)');
              void refresh().then(() => openAgent(id));
            }}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

// ── Fiches des agents ───────────────────────────────────────────────────────
function AgentsView({
  agents,
  comptes,
  selected,
  onSelect,
  onChanged,
  onError,
}: {
  agents: AgentSummary[];
  comptes: Compte[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChanged: (msg: string) => void;
  onError: (m: string) => void;
}): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16 }}>
      <div>
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              marginBottom: 6,
              padding: 8,
              background: selected === a.id ? 'var(--color-active-bg)' : 'var(--color-bg-dark)',
              color: 'var(--color-text)',
              border: `2px solid ${selected === a.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
              fontFamily: 'var(--font-pixel)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <Avatar name={a.prenom} />
            <span>
              {a.prenom}
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{a.role}</div>
            </span>
          </button>
        ))}
      </div>
      {selected ? (
        <AgentSheet key={selected} id={selected} comptes={comptes} onChanged={onChanged} onError={onError} />
      ) : (
        <div>Aucun agent.</div>
      )}
    </div>
  );
}

function AgentSheet({
  id,
  comptes,
  onChanged,
  onError,
}: {
  id: string;
  comptes: Compte[];
  onChanged: (msg: string) => void;
  onError: (m: string) => void;
}): React.JSX.Element {
  const [d, setD] = useState<AgentDetail | null>(null);
  const [identity, setIdentity] = useState<Partial<AgentSummary>>({});
  const [regles, setRegles] = useState<Regle[]>([]);
  const [fiche, setFiche] = useState('');
  const [lib, setLib] = useState<Competence[]>([]);
  const [search, setSearch] = useState('');
  const [hist, setHist] = useState<Commit[]>([]);
  const [outils, setOutils] = useState<Outil[]>([]);
  const [personnes, setPersonnes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const det = await agentsApi<AgentDetail>('agent', [id]);
      setD(det);
      setIdentity(det.agent);
      setRegles(det.regles.regles ?? []);
      setFiche(det.fiche);
      setHist(await agentsApi<Commit[]>('historique', [id]));
    } catch (e) {
      onError(errMsg(e));
    }
  }, [id, onError]);

  useEffect(() => {
    void load();
    void agentsApi<Competence[]>('bibliotheque')
      .then(setLib)
      .catch(() => undefined);
    void agentsApi<Outil[]>('outils')
      .then(setOutils)
      .catch(() => undefined);
    void agentsApi<string[]>('personnes')
      .then(setPersonnes)
      .catch(() => undefined);
  }, [load]);

  const run = async (fn: () => Promise<unknown>, msg: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      onChanged(msg);
      await load();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!d) return <div style={{ opacity: 0.6 }}>Chargement…</div>;
  const a = d.agent;
  const mine = new Set(d.competences.map((c) => c.nom));
  const q = search.trim().toLowerCase();
  const libFiltered = lib.filter((c) => !mine.has(c.nom) && (!q || `${c.nom} ${c.description}`.toLowerCase().includes(q)));
  const setId = (k: keyof AgentSummary, v: string): void => setIdentity((x) => ({ ...x, [k]: v }));

  return (
    <div>
      <Card
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar name={a.prenom} size={44} />
            <span>
              {a.prenom} — {a.role}
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontWeight: 400 }}>
                {a.pole} · responsable {a.responsable} · 7 jours : {a.stats.missions_7j} missions, {a.stats.actions_7j}{' '}
                actions, {a.stats.refus_7j} refus du garde-fou, {a.stats.validations_en_attente} validation(s) en attente
              </div>
            </span>
          </span>
        }
        right={
          a.en_pause ? (
            <Btn kind="success" disabled={busy} onClick={() => void run(() => agentsApi('reprise', [id]), `${a.prenom} reprend le travail`)}>
              ▶ Reprendre
            </Btn>
          ) : (
            <Btn kind="danger" disabled={busy} onClick={() => void run(() => agentsApi('pause', [id]), `${a.prenom} est en pause`)}>
              ⏸ Mettre en pause
            </Btn>
          )
        }
      >
        {a.note_compte && <div style={{ color: 'var(--color-warning)', fontSize: '0.8125rem' }}>⚠ {a.note_compte}</div>}
      </Card>

      <Card
        title="Identité et compte Claude"
        right={
          <Btn
            kind="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const { compte_claude, compte_secours, ...rest } = identity;
                const fields = ['prenom', 'role', 'pole', 'responsable', 'presentation_teams', 'canal_teams', 'niveau_initiative', 'statut', 'heures_calmes'] as const;
                const agentPatch = Object.fromEntries(fields.map((f) => [f, (rest as Record<string, unknown>)[f] ?? '']));
                await agentsApi('maj_agent', [id], { agent: agentPatch });
                if (compte_claude && (compte_claude !== a.compte_claude || (compte_secours ?? '') !== (a.compte_secours ?? ''))) {
                  await agentsApi('compte_affecter', [id, compte_claude, compte_secours ?? '']);
                }
              }, 'Identité enregistrée et versionnée')
            }
          >
            Enregistrer
          </Btn>
        }
      >
        <Field label="Prénom">
          <input style={inputStyle} value={identity.prenom ?? ''} onChange={(e) => setId('prenom', e.target.value)} />
        </Field>
        <Field label="Rôle">
          <input style={inputStyle} value={identity.role ?? ''} onChange={(e) => setId('role', e.target.value)} />
        </Field>
        <Field label="Pôle">
          <input style={inputStyle} value={identity.pole ?? ''} onChange={(e) => setId('pole', e.target.value)} />
        </Field>
        <Field label="Responsable humain">
          <input style={inputStyle} value={identity.responsable ?? ''} onChange={(e) => setId('responsable', e.target.value)} />
        </Field>
        <Field label="Présentation (Teams)">
          <input style={inputStyle} value={identity.presentation_teams ?? ''} onChange={(e) => setId('presentation_teams', e.target.value)} />
        </Field>
        <Field label="Canal Teams">
          <input style={inputStyle} value={identity.canal_teams ?? ''} onChange={(e) => setId('canal_teams', e.target.value)} />
        </Field>
        <Field label="Statut">
          <select style={inputStyle} value={identity.statut ?? 'observation'} onChange={(e) => setId('statut', e.target.value)}>
            <option value="observation">Observation (propose, n'agit pas)</option>
            <option value="en_service">En service (agit selon ses règles)</option>
          </select>
        </Field>
        <Field label="Niveau d'initiative">
          <select style={inputStyle} value={identity.niveau_initiative ?? 'proactif'} onChange={(e) => setId('niveau_initiative', e.target.value)}>
            <option value="executant">Exécutant (répond aux demandes)</option>
            <option value="proactif">Proactif (propose et relance)</option>
            <option value="tres_proactif">Très proactif</option>
          </select>
        </Field>
        <Field label="Heures calmes">
          <input style={inputStyle} value={identity.heures_calmes ?? ''} onChange={(e) => setId('heures_calmes', e.target.value)} />
        </Field>
        <Field label="Compte Claude">
          <select style={inputStyle} value={identity.compte_claude ?? ''} onChange={(e) => setId('compte_claude', e.target.value)}>
            {comptes.map((c) => (
              <option key={c.nom} value={c.nom}>
                {c.libelle}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Compte de secours">
          <select style={inputStyle} value={identity.compte_secours ?? ''} onChange={(e) => setId('compte_secours', e.target.value)}>
            <option value="">— aucun —</option>
            {comptes
              .filter((c) => c.nom !== identity.compte_claude)
              .map((c) => (
                <option key={c.nom} value={c.nom}>
                  {c.libelle}
                </option>
              ))}
          </select>
        </Field>
      </Card>

      <ReglesEditor
        key={`regles-${hist[0]?.commit ?? ''}`}
        regles={regles}
        escalade={d.regles.escalade ?? {}}
        plafonds={a.plafonds ?? {}}
        personnes={personnes}
        busy={busy}
        onSave={(r, e, p) =>
          void run(async () => {
            await agentsApi('maj_agent', [id], { regles: r, escalade: e });
            await agentsApi('maj_agent', [id], { agent: { plafonds: p } });
          }, 'Règles, escalade et limites enregistrées')
        }
      />

      <Card title={`Compétences (${d.competences.length})`}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            {d.competences.map((c) => (
              <div key={c.nom} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ flex: 1, fontSize: '0.75rem' }} title={c.nom}>
                  ✅ {c.description || c.nom}
                </span>
                <Btn disabled={busy} onClick={() => void run(() => agentsApi('competence', [id, 'retirer', c.nom]), 'Compétence retirée')}>
                  Retirer
                </Btn>
              </div>
            ))}
          </div>
          <div>
            <input style={{ ...inputStyle, marginBottom: 6 }} placeholder="🔍 Chercher dans la bibliothèque…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div style={{ maxHeight: 290, overflow: 'auto' }}>
              {libFiltered.slice(0, 60).map((c) => (
                <div key={c.nom} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ flex: 1, fontSize: '0.75rem' }} title={c.nom}>
                    {c.description || c.nom}
                  </span>
                  <Btn disabled={busy} onClick={() => void run(() => agentsApi('competence', [id, 'ajouter', c.nom]), 'Compétence ajoutée')}>
                    + Ajouter
                  </Btn>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <AccesEditor
        key={`acces-${hist[0]?.commit ?? ''}`}
        value={{
          outils_commandes: d.acces.outils_commandes ?? {},
          passbolt_dossiers: d.acces.passbolt_dossiers ?? [],
          ecriture_fichiers: Boolean(d.acces.ecriture_fichiers),
          clients_exclus: d.acces.clients_exclus ?? [],
        }}
        outils={outils}
        routines={a.routines ?? []}
        competences={d.competences.map((c) => c.nom)}
        busy={busy}
        onSave={(acc, rt) =>
          void run(async () => {
            await agentsApi('maj_agent', [id], { acces: acc });
            await agentsApi('maj_agent', [id], { agent: { routines: rt } });
          }, 'Accès et tâches planifiées enregistrés')
        }
      />

      <Card
        title="Fiche de poste"
        right={
          <Btn kind="primary" disabled={busy} onClick={() => void run(() => agentsApi('maj_agent', [id], { fiche }), 'Fiche de poste enregistrée')}>
            Enregistrer
          </Btn>
        }
      >
        <textarea style={{ ...inputStyle, minHeight: 200, fontFamily: 'var(--font-mono)' }} value={fiche} onChange={(e) => setFiche(e.target.value)} />
      </Card>

      <Card title="Historique des modifications">
        {hist.slice(0, 15).map((h) => (
          <div key={h.commit} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.75rem', marginBottom: 4 }}>
            <span style={{ color: 'var(--color-text-muted)', width: 120 }}>{h.date}</span>
            <span style={{ flex: 1 }}>
              {h.message} <span style={{ color: 'var(--color-text-muted)' }}>· {h.auteur}</span>
            </span>
            <Btn disabled={busy} title="Annuler cette modification" onClick={() => void run(() => agentsApi('revenir', [h.commit]), 'Modification annulée')}>
              ↶ Revenir
            </Btn>
          </div>
        ))}
      </Card>

      {d.memoire && (
        <Card title="Carnet de bord (tenu par l'agent)">
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', margin: 0, fontFamily: 'var(--font-mono)' }}>{d.memoire}</pre>
        </Card>
      )}
    </div>
  );
}

// ── Comptes Claude ──────────────────────────────────────────────────────────
function ComptesView({
  comptes,
  onChanged,
  onError,
}: {
  comptes: Compte[];
  onChanged: () => void;
  onError: (m: string) => void;
}): React.JSX.Element {
  const [nom, setNom] = useState('');
  const [libelle, setLibelle] = useState('');
  return (
    <div>
      <Card title="+ Ajouter un compte Claude">
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: 8 }}>
          Un Terminal s'ouvre : tapez /login, connectez-vous avec le compte voulu, puis /exit. Le compte apparaît ensuite dans la liste
          déroulante des fiches agents. Un compte peut servir à plusieurs agents.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={inputStyle} placeholder="nom court (ex. agents-1)" value={nom} onChange={(e) => setNom(e.target.value)} />
          <input style={inputStyle} placeholder="libellé (ex. Agents — forfait Max)" value={libelle} onChange={(e) => setLibelle(e.target.value)} />
          <Btn
            kind="primary"
            disabled={!nom.trim()}
            onClick={() =>
              void agentsApi('ajouter_compte', [nom.trim(), libelle.trim() || nom.trim()])
                .then(() => {
                  setNom('');
                  setLibelle('');
                  onChanged();
                })
                .catch((e) => onError(errMsg(e)))
            }
          >
            Ajouter et connecter
          </Btn>
        </div>
      </Card>
      {comptes.map((c) => {
        const pct = Math.min(100, Math.round((c.en_cours / Math.max(1, c.max_simultanees)) * 100));
        return (
          <Card
            key={c.nom}
            title={c.libelle}
            right={c.connecte ? <Chip color="var(--color-status-success)">connecté</Chip> : <Chip color="var(--color-warning)">à connecter</Chip>}
          >
            <div style={{ fontSize: '0.8125rem', marginBottom: 6 }}>
              Sessions en cours : {c.en_cours} / {c.max_simultanees} · en attente : {c.en_attente} · exécutions 24 h : {c.executions_24h} · 7 j :{' '}
              {c.executions_7j}
              {c.sature_jusqua && (
                <span style={{ color: 'var(--color-danger)' }}> · ⛔ limite atteinte jusqu'à {new Date(c.sature_jusqua * 1000).toLocaleTimeString()}</span>
              )}
            </div>
            <div style={{ height: 10, background: 'var(--color-bg)', border: '2px solid var(--color-border)' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-accent-bright)' }} />
            </div>
            <div style={{ marginTop: 6 }}>
              {c.agents.map((a) => (
                <Chip key={a}>{a}</Chip>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── Nouvel agent ────────────────────────────────────────────────────────────
function NouvelAgent({
  agents,
  comptes,
  onCreated,
  onError,
}: {
  agents: AgentSummary[];
  comptes: Compte[];
  onCreated: (id: string) => void;
  onError: (m: string) => void;
}): React.JSX.Element {
  const [f, setF] = useState({
    modele: 'vierge',
    prenom: '',
    role: '',
    pole: '',
    responsable: '',
    presentation_teams: '',
    canal_teams: '',
    compte_claude: comptes[0]?.nom ?? '',
  });
  const set = (k: keyof typeof f, v: string): void => setF((x) => ({ ...x, [k]: v }));
  return (
    <div style={{ maxWidth: 760 }}>
      <Card title="1. Partir d'un modèle">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[{ id: 'vierge', prenom: 'Page blanche', role: '' }, ...agents].map((m) => (
            <Btn key={m.id} kind={f.modele === m.id ? 'primary' : 'normal'} onClick={() => set('modele', m.id)}>
              {m.id === 'vierge' ? '✨ Page blanche' : `Copier ${m.prenom} (${m.role})`}
            </Btn>
          ))}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 6 }}>
          Copier un agent reprend ses compétences, accès et règles ; tout reste modifiable ensuite dans sa fiche.
        </div>
      </Card>
      <Card title="2. Identité">
        <Field label="Prénom">
          <input style={inputStyle} value={f.prenom} onChange={(e) => set('prenom', e.target.value)} />
        </Field>
        <Field label="Rôle">
          <input style={inputStyle} placeholder="ex. Agent Infogérance" value={f.role} onChange={(e) => set('role', e.target.value)} />
        </Field>
        <Field label="Pôle">
          <input style={inputStyle} placeholder="ex. Infogérance" value={f.pole} onChange={(e) => set('pole', e.target.value)} />
        </Field>
        <Field label="Responsable humain">
          <input style={inputStyle} value={f.responsable} onChange={(e) => set('responsable', e.target.value)} />
        </Field>
        <Field label="Présentation (Teams)">
          <input style={inputStyle} value={f.presentation_teams} onChange={(e) => set('presentation_teams', e.target.value)} />
        </Field>
        <Field label="Canal Teams">
          <input style={inputStyle} placeholder="#canal" value={f.canal_teams} onChange={(e) => set('canal_teams', e.target.value)} />
        </Field>
        <Field label="Compte Claude">
          <select style={inputStyle} value={f.compte_claude} onChange={(e) => set('compte_claude', e.target.value)}>
            {comptes.map((c) => (
              <option key={c.nom} value={c.nom}>
                {c.libelle}
              </option>
            ))}
          </select>
        </Field>
      </Card>
      <Btn
        kind="primary"
        disabled={!f.prenom.trim() || !f.role.trim()}
        onClick={() =>
          void agentsApi<{ id: string }>('creer_agent', [], f)
            .then((r) => onCreated(r.id))
            .catch((e) => onError(errMsg(e)))
        }
      >
        🚀 Créer l'agent (en mode observation)
      </Btn>
      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 8 }}>
        Il est créé en observation : il propose sans agir. Ajoutez ensuite ses compétences et ses règles dans sa fiche.
      </div>
    </div>
  );
}
