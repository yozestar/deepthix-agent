// SKILLS pane — list claude code skills (global + project + plugin) and
// let the user toggle `disable-model-invocation` per skill. Plugin
// skills are read-only because editing them gets clobbered on the next
// plugin update.
//
// "Disabled" here = claude won't auto-load the skill, but the user can
// still invoke it manually with /skill-name. There's no global
// "disabledSkills" array in claude — frontmatter is the only knob.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { listSkills, setSkillEnabled, type SkillInfo } from '../tauri/commands';

interface Props {
  projectPath: string | null;
}

const REFRESH_HINT_MS = 4_000;

export function SkillsPane({ projectPath }: Props): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listSkills(projectPath);
      setSkills(list);
      setError(null);
    } catch (e) {
      console.warn('[Deepthix][SkillsPane] list failed', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggle = useCallback(
    async (skill: SkillInfo): Promise<void> => {
      const next = skill.disabled; // disabled→enabled means we WANT enabled=true
      setPendingPaths((s) => new Set([...s, skill.path]));
      try {
        await setSkillEnabled(skill.path, next);
        // Optimistic local update — saves the round trip flicker.
        setSkills((prev) =>
          prev
            ? prev.map((s) => (s.path === skill.path ? { ...s, disabled: !next } : s))
            : prev,
        );
      } catch (e) {
        console.warn('[Deepthix][SkillsPane] toggle failed', e);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingPaths((s) => {
          const next = new Set(s);
          next.delete(skill.path);
          return next;
        });
      }
    },
    [],
  );

  // Group + filter
  const groups = useMemo(() => {
    if (!skills) return null;
    const f = filter.trim().toLowerCase();
    const matchesFilter = (s: SkillInfo): boolean =>
      f === '' ||
      s.name.toLowerCase().includes(f) ||
      s.description.toLowerCase().includes(f) ||
      (s.plugin ?? '').toLowerCase().includes(f);
    const list = skills.filter(matchesFilter);
    return {
      project: list.filter((s) => s.scope === 'project'),
      global: list.filter((s) => s.scope === 'global'),
      plugin: list.filter((s) => s.scope === 'plugin'),
    };
  }, [skills, filter]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: 'var(--color-bg)',
        padding: '20px 24px',
        overflow: 'auto',
        fontFamily: 'var(--font-pixel)',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '15px', letterSpacing: '0.06em' }}>SKILLS</span>
          <span style={{ fontSize: '12px', opacity: 0.6 }}>
            Toggle `disable-model-invocation` for global / project skills. Plugin skills are
            read-only.
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            style={{
              background: 'var(--color-bg-dark)',
              color: 'inherit',
              border: '2px solid var(--color-border)',
              padding: '4px 8px',
              fontFamily: 'var(--font-pixel)',
              fontSize: '12px',
              minWidth: '180px',
            }}
          />
          <button
            type="button"
            onClick={() => void refresh()}
            title={`Re-scan disk (skills are also picked up live by claude within ${REFRESH_HINT_MS / 1000}s)`}
            style={{
              padding: '4px 10px',
              background: 'transparent',
              color: 'inherit',
              border: '2px solid var(--color-border)',
              fontFamily: 'var(--font-pixel)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            ⟳ refresh
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            color: 'var(--color-danger)',
            border: '2px solid var(--color-danger)',
            padding: '6px 10px',
            fontSize: '12px',
          }}
        >
          {error}
        </div>
      )}

      {!skills && !error && (
        <div style={{ opacity: 0.6, fontSize: '13px' }}>scanning skills…</div>
      )}

      {groups && (
        <>
          <SkillSection
            title="Project skills"
            subtitle={projectPath ? projectPath : 'no active project'}
            empty="No project skills. Create them in <project>/.claude/skills/<name>/SKILL.md."
            skills={groups.project}
            onToggle={onToggle}
            pendingPaths={pendingPaths}
            readonly={false}
          />
          <SkillSection
            title="Global skills"
            subtitle="~/.claude/skills/"
            empty="No global skills. Create one in ~/.claude/skills/<name>/SKILL.md."
            skills={groups.global}
            onToggle={onToggle}
            pendingPaths={pendingPaths}
            readonly={false}
          />
          <SkillSection
            title="Plugin skills"
            subtitle="provided by installed plugins — read-only"
            empty="No plugin skills installed."
            skills={groups.plugin}
            onToggle={onToggle}
            pendingPaths={pendingPaths}
            readonly={true}
          />
        </>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  subtitle: string;
  empty: string;
  skills: SkillInfo[];
  pendingPaths: Set<string>;
  onToggle: (s: SkillInfo) => void;
  readonly: boolean;
}

function SkillSection({
  title,
  subtitle,
  empty,
  skills,
  pendingPaths,
  onToggle,
  readonly,
}: SectionProps): React.JSX.Element {
  return (
    <div
      style={{
        background: 'var(--color-bg)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: '13px', letterSpacing: '0.06em' }}>{title}</span>
          <span style={{ fontSize: '11px', opacity: 0.55 }}>
            {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
          </span>
        </div>
        <span
          style={{
            fontSize: '11px',
            opacity: 0.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={subtitle}
        >
          {subtitle}
        </span>
      </div>
      {skills.length === 0 ? (
        <div style={{ padding: '14px 12px', fontSize: '12px', opacity: 0.55 }}>{empty}</div>
      ) : (
        <div>
          {skills.map((s) => (
            <SkillRow
              key={s.path}
              skill={s}
              pending={pendingPaths.has(s.path)}
              onToggle={() => onToggle(s)}
              readonly={readonly}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  skill: SkillInfo;
  pending: boolean;
  onToggle: () => void;
  readonly: boolean;
}

function SkillRow({ skill, pending, onToggle, readonly }: RowProps): React.JSX.Element {
  const enabled = !skill.disabled;
  return (
    <div
      style={{
        display: 'flex',
        gap: '10px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--color-border)',
        opacity: pending ? 0.5 : 1,
      }}
    >
      <div style={{ flexShrink: 0, paddingTop: 2 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={readonly || pending}
          onChange={onToggle}
          title={
            readonly
              ? 'plugin skill — managed by the plugin manager'
              : enabled
                ? 'click to disable model auto-invocation'
                : 'click to re-enable model auto-invocation'
          }
          style={{ cursor: readonly ? 'not-allowed' : 'pointer' }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px' }}>
            {skill.plugin && (
              <span style={{ opacity: 0.6 }}>{skill.plugin}:</span>
            )}
            {skill.name}
          </span>
          {skill.hidden_from_menu && (
            <span
              style={{
                fontSize: '10px',
                padding: '1px 6px',
                background: 'var(--color-bg-dark)',
                border: '1px solid var(--color-border)',
                opacity: 0.7,
              }}
              title="user-invocable: false — hidden from /menu"
            >
              hidden
            </span>
          )}
          {!enabled && (
            <span
              style={{
                fontSize: '10px',
                padding: '1px 6px',
                background: 'var(--color-bg-dark)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-danger)',
              }}
            >
              disabled
            </span>
          )}
        </div>
        {skill.description && (
          <div
            style={{
              fontSize: '11px',
              opacity: 0.7,
              lineHeight: 1.4,
            }}
          >
            {skill.description}
          </div>
        )}
        <div
          style={{
            fontSize: '10px',
            opacity: 0.4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={skill.path}
        >
          {skill.path}
        </div>
      </div>
    </div>
  );
}
