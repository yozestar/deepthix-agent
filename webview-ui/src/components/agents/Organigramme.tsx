// Organisation chart (design v2): direction on top, one column per pole, each
// human manager is a drop zone. Drag an agent onto another manager / pole to
// change who it reports to — saved and versioned by the engine (revertable).

import { useMemo, useState } from 'react';

import type { AgentSummary, Pole } from './model';

function statusOf(a: AgentSummary): { label: string; color: string } {
  if (a.en_pause) return { label: '⏸ En pause', color: 'var(--color-danger)' };
  if (a.statut === 'observation') return { label: '👁 Observation', color: 'var(--color-warning)' };
  return { label: '● En service', color: 'var(--color-status-success)' };
}

function Person({ name, sub }: { name: string; sub: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 12,
          background: 'var(--color-btn-hover)',
          display: 'grid',
          placeItems: 'center',
          fontWeight: 800,
          flex: 'none',
        }}
      >
        {name.slice(0, 1)}
      </span>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{name}</div>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{sub}</div>
      </div>
    </div>
  );
}

export function Organigramme({
  poles,
  agents,
  onOpen,
  onNew,
  onMove,
}: {
  poles: Pole[];
  agents: AgentSummary[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onMove: (agentId: string, pole: string, responsable: string) => void;
}): React.JSX.Element {
  const [over, setOver] = useState<string | null>(null);
  const [extraPole, setExtraPole] = useState('');
  const byId = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);
  // Zones: one per (pole, manager). Agents are listed under their manager.
  const columns = poles.map((p) => ({
    nom: p.nom,
    managers: (p.responsables.length ? p.responsables : ['—']).map((m) => ({
      nom: m,
      agents: p.agents.filter((id) => (byId[id]?.responsable || '—') === m),
    })),
  }));

  const zone = (pole: string, m: { nom: string; agents: string[] }): React.JSX.Element => {
    const key = `${pole}|${m.nom}`;
    return (
      <div
        key={key}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(key);
        }}
        onDragLeave={() => setOver((x) => (x === key ? null : x))}
        onDrop={(e) => {
          e.preventDefault();
          setOver(null);
          const id = e.dataTransfer.getData('text/agent');
          if (id && (byId[id]?.pole !== pole || byId[id]?.responsable !== m.nom)) onMove(id, pole, m.nom === '—' ? '' : m.nom);
        }}
        style={{
          borderRadius: 18,
          padding: 12,
          marginBottom: 12,
          minHeight: 96,
          border: `1.5px dashed ${over === key ? 'var(--color-accent-bright)' : 'var(--color-border)'}`,
          background: over === key ? 'var(--color-active-bg)' : 'transparent',
          transform: over === key ? 'scale(1.01)' : 'none',
          transition: '0.15s',
        }}
      >
        <Person name={m.nom} sub="Responsable humain" />
        {m.agents.map((id) => {
          const a = byId[id];
          if (!a) return null;
          const st = statusOf(a);
          return (
            <div
              key={id}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/agent', id)}
              onClick={() => onOpen(id)}
              className="v2-hover-lift"
              title="Glisser pour changer de responsable · cliquer pour ouvrir la fiche"
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                margin: '10px 0 0 22px',
                padding: '8px 10px',
                borderRadius: 14,
                background: 'var(--color-btn-bg)',
                border: '1px solid var(--color-border)',
                cursor: 'grab',
              }}
            >
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  background: a.couleur ?? 'var(--gradient-accent)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 20,
                  flex: 'none',
                }}
              >
                {a.emoji ?? '🤖'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800 }}>{a.prenom}</div>
                <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                  <span style={{ color: st.color }}>{st.label}</span> · {a.nb_competences} compétences
                </div>
              </div>
              {a.stats.validations_en_attente > 0 && (
                <span style={{ background: 'var(--color-warning)', color: 'var(--color-bg)', borderRadius: 9, padding: '0 7px', fontWeight: 800 }}>
                  {a.stats.validations_en_attente}
                </span>
              )}
            </div>
          );
        })}
        {m.agents.length === 0 && <div style={{ marginLeft: 22, marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>déposer un agent ici</div>}
      </div>
    );
  };

  return (
    <div className="v2-fade">
      <div style={{ color: 'var(--color-text-muted)', marginBottom: 14, fontSize: 13 }}>
        ✋ <b>Glisse un agent</b> sur un autre responsable ou un autre pôle pour changer son rattachement (enregistré, avec retour arrière dans sa fiche). Clique
        sur un agent pour régler ses compétences, ses accès et ses règles.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, columns.length + 1)}, minmax(240px, 1fr))`, gap: 16 }}>
        {columns.map((c) => (
          <div key={c.nom}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 800, marginBottom: 10 }}>{c.nom}</div>
            {c.managers.map((m) => zone(c.nom, m))}
            {(poles.find((p) => p.nom === c.nom)?.membres ?? []).length > 0 && (
              <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(poles.find((p) => p.nom === c.nom)?.membres ?? []).map((n) => (
                  <span key={n} title="Collaborateur du pôle" style={{ fontSize: 12, padding: '4px 10px', borderRadius: 999, background: 'var(--color-btn-bg)' }}>
                    🙂 {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        <div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 800, marginBottom: 10 }}>
            Nouveau pôle
          </div>
          <input
            value={extraPole}
            onChange={(e) => setExtraPole(e.target.value)}
            placeholder="ex. Infogérance"
            style={{
              width: '100%',
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 12,
              padding: '8px 10px',
              color: 'var(--color-text)',
              marginBottom: 10,
            }}
          />
          {extraPole.trim() && zone(extraPole.trim(), { nom: 'Johann Chekroun', agents: [] })}
          <button
            type="button"
            onClick={onNew}
            className="v2-hover-lift"
            style={{
              width: '100%',
              padding: 22,
              borderRadius: 18,
              border: '1.5px dashed var(--color-border)',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            ✨ Nouvel agent
          </button>
        </div>
      </div>
    </div>
  );
}
