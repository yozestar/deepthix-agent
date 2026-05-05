// SKILLS pane — list claude code skills (global + project + plugin) and
// let the user toggle `disable-model-invocation` per skill. Plugin
// skills are read-only because editing them gets clobbered on the next
// plugin update.
//
// "Disabled" here = claude won't auto-load the skill, but the user can
// still invoke it manually with /skill-name. There's no global
// "disabledSkills" array in claude — frontmatter is the only knob.
//
// New in v0.3.9:
//   - Click any row → opens a viewer modal with the rendered SKILL.md.
//   - Drag a folder containing SKILL.md (or a single .md file) onto the
//     pane → installs it under the chosen scope.
//   - "+ Add" button opens the OS file picker as a drag-drop fallback.
//   - "Marketplace" section fetches a curated catalog from the deepthix
//     repo and offers 1-click install for each skill.

import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  deleteSkill,
  installSkillFromPath,
  installSkillFromText,
  listSkills,
  readSkillFile,
  setSkillEnabled,
  type SkillInfo,
} from '../tauri/commands';
import {
  fetchMarketplaceCatalog,
  fetchSkillContent,
  type MarketplaceCatalog,
  type MarketplaceSkill,
} from '../skillsMarketplace';

interface Props {
  projectPath: string | null;
}

const REFRESH_HINT_MS = 4_000;

type InstallScope = 'global' | 'project';

export function SkillsPane({ projectPath }: Props): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());
  const [viewerSkill, setViewerSkill] = useState<SkillInfo | null>(null);
  const [installScope, setInstallScope] = useState<InstallScope>(
    projectPath ? 'project' : 'global',
  );
  // Bumps every time we install/delete to force the marketplace section
  // to re-evaluate which entries are already installed.
  const [installCounter, setInstallCounter] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);

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

  // When the active project changes, switch the install scope to
  // "project" by default (most common UX). The user can still flip
  // to "global" via the radio.
  useEffect(() => {
    if (projectPath) setInstallScope('project');
    else setInstallScope('global');
  }, [projectPath]);

  // Tauri 2 file drag-drop. The browser-level dragover/drop events on
  // the dropZone div only give us file objects, not paths. Tauri's
  // webview-level event hands us the absolute path the OS shell knows
  // — that's what install_skill_from_path needs. We listen at the
  // webview level and gate by whether the cursor is over our dropZone
  // (cleared/set by the local dragenter / dragleave handlers).
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const cursorOverDropRef = useRef(false);
  const installScopeRef = useRef(installScope);
  const projectPathRef = useRef(projectPath);
  useEffect(() => {
    installScopeRef.current = installScope;
  }, [installScope]);
  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  const installFromSourcePath = useCallback(
    async (sourcePath: string, allowOverwrite = false): Promise<void> => {
      setInstalling(sourcePath);
      setError(null);
      try {
        const dest = await installSkillFromPath({
          sourcePath,
          scope: installScopeRef.current,
          projectPath: projectPathRef.current,
          overwrite: allowOverwrite,
        });
        console.info('[Deepthix][SkillsPane] installed', { sourcePath, dest });
        setInstallCounter((n) => n + 1);
        await refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already exists/.test(msg)) {
          if (window.confirm(`${msg}\n\nReplace it?`)) {
            await installFromSourcePath(sourcePath, true);
            return;
          }
        }
        console.warn('[Deepthix][SkillsPane] install from path failed', e);
        setError(msg);
      } finally {
        setInstalling(null);
      }
    },
    [refresh],
  );

  useEffect(() => {
    const off = getCurrentWebview()
      .onDragDropEvent((evt) => {
        // Tauri 2 event payload: { type: 'enter'|'over'|'drop'|'leave', paths?, position? }
        const payload = evt.payload as {
          type: 'enter' | 'over' | 'drop' | 'leave';
          paths?: string[];
        };
        if (payload.type !== 'drop') return;
        if (!cursorOverDropRef.current) return;
        const paths = payload.paths ?? [];
        if (paths.length === 0) return;
        // Install one at a time to surface errors clearly.
        void (async () => {
          for (const p of paths) {
            await installFromSourcePath(p);
          }
        })();
      })
      .catch((e: unknown) => {
        console.warn('[Deepthix][SkillsPane] onDragDropEvent failed', e);
      });
    return () => {
      void off?.then((unlisten) => {
        if (typeof unlisten === 'function') unlisten();
      });
    };
  }, [installFromSourcePath]);

  const onPickFile = useCallback(async (): Promise<void> => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Skill', extensions: ['md'] }],
      });
      if (!picked || typeof picked !== 'string') return;
      await installFromSourcePath(picked);
    } catch (e) {
      console.warn('[Deepthix][SkillsPane] pick file failed', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [installFromSourcePath]);

  const onPickFolder = useCallback(async (): Promise<void> => {
    try {
      const picked = await openFileDialog({ multiple: false, directory: true });
      if (!picked || typeof picked !== 'string') return;
      await installFromSourcePath(picked);
    } catch (e) {
      console.warn('[Deepthix][SkillsPane] pick folder failed', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [installFromSourcePath]);

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

  const onDelete = useCallback(
    async (skill: SkillInfo): Promise<void> => {
      if (!window.confirm(`Delete skill "${skill.name}"? This removes ${skill.path}.`)) return;
      try {
        await deleteSkill(skill.path);
        setInstallCounter((n) => n + 1);
        await refresh();
      } catch (e) {
        console.warn('[Deepthix][SkillsPane] delete failed', e);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
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
      ref={dropZoneRef}
      onDragEnter={() => {
        cursorOverDropRef.current = true;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        cursorOverDropRef.current = true;
      }}
      onDragLeave={() => {
        cursorOverDropRef.current = false;
        setDragOver(false);
      }}
      onDrop={() => {
        // The actual file install happens in the Tauri webview-level
        // listener above (it has the OS path; the browser drop event
        // does not). We just clear the visual hint here.
        cursorOverDropRef.current = false;
        setDragOver(false);
      }}
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
        position: 'relative',
        outline: dragOver ? '3px dashed var(--color-accent)' : 'none',
        outlineOffset: -8,
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
            Drop a SKILL.md folder anywhere on this pane to install. Click a row to view.
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
              minWidth: '160px',
            }}
          />
          <button
            type="button"
            onClick={() => void onPickFile()}
            disabled={installing !== null}
            title="Pick a single .md file to install as a skill"
            style={iconBtnStyle}
          >
            + .md file
          </button>
          <button
            type="button"
            onClick={() => void onPickFolder()}
            disabled={installing !== null}
            title="Pick a folder containing SKILL.md to install"
            style={iconBtnStyle}
          >
            + folder
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            title={`Re-scan disk (skills are also picked up live by claude within ${REFRESH_HINT_MS / 1000}s)`}
            style={iconBtnStyle}
          >
            ⟳ refresh
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 11,
          opacity: 0.85,
        }}
      >
        <span>Install scope:</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="radio"
            checked={installScope === 'project'}
            disabled={!projectPath}
            onChange={() => setInstallScope('project')}
          />
          project {projectPath ? `(${shortenPath(projectPath)})` : '(no active project)'}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="radio"
            checked={installScope === 'global'}
            onChange={() => setInstallScope('global')}
          />
          global (~/.claude/skills)
        </label>
        {installing && (
          <span style={{ opacity: 0.7 }}>installing {shortenPath(installing)}…</span>
        )}
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
            empty="No project skills. Drop a SKILL.md folder above or browse the marketplace below."
            skills={groups.project}
            onToggle={onToggle}
            onView={setViewerSkill}
            onDelete={onDelete}
            pendingPaths={pendingPaths}
            readonly={false}
          />
          <SkillSection
            title="Global skills"
            subtitle="~/.claude/skills/"
            empty="No global skills. Drop a SKILL.md folder above or browse the marketplace below."
            skills={groups.global}
            onToggle={onToggle}
            onView={setViewerSkill}
            onDelete={onDelete}
            pendingPaths={pendingPaths}
            readonly={false}
          />
          <SkillSection
            title="Plugin skills"
            subtitle="provided by installed plugins — toggles may be reverted on plugin update"
            empty="No plugin skills installed."
            skills={groups.plugin}
            onToggle={onToggle}
            onView={setViewerSkill}
            onDelete={onDelete}
            pendingPaths={pendingPaths}
            readonly={false}
          />
        </>
      )}

      <MarketplaceSection
        open={marketplaceOpen}
        setOpen={setMarketplaceOpen}
        installedNames={new Set(skills?.map((s) => s.name) ?? [])}
        installCounter={installCounter}
        installScope={installScope}
        projectPath={projectPath}
        onInstalled={() => {
          setInstallCounter((n) => n + 1);
          void refresh();
        }}
      />

      {viewerSkill && (
        <SkillViewer skill={viewerSkill} onClose={() => setViewerSkill(null)} />
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  color: 'inherit',
  border: '2px solid var(--color-border)',
  fontFamily: 'var(--font-pixel)',
  fontSize: '12px',
  cursor: 'pointer',
};

function shortenPath(p: string): string {
  if (p.length <= 36) return p;
  return `…${p.slice(-34)}`;
}

interface SectionProps {
  title: string;
  subtitle: string;
  empty: string;
  skills: SkillInfo[];
  pendingPaths: Set<string>;
  onToggle: (s: SkillInfo) => void;
  onView: (s: SkillInfo) => void;
  onDelete: (s: SkillInfo) => void;
  readonly: boolean;
}

function SkillSection({
  title,
  subtitle,
  empty,
  skills,
  pendingPaths,
  onToggle,
  onView,
  onDelete,
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
              onView={() => onView(s)}
              onDelete={() => onDelete(s)}
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
  onView: () => void;
  onDelete: () => void;
  readonly: boolean;
}

function SkillRow({
  skill,
  pending,
  onToggle,
  onView,
  onDelete,
  readonly,
}: RowProps): React.JSX.Element {
  const enabled = !skill.disabled;
  const isPlugin = skill.scope === 'plugin';
  // Bigger, color-coded ACTIVE / DISABLED pill so the user can tell at a
  // glance whether claude will auto-load this skill. The hidden tiny
  // checkbox alone wasn't legible (user reported "on comprend pas où
  // les skills sont actives ou non" against the v0.3.10 layout).
  const badgeBg = enabled ? '#16a34a' : '#6b7280';
  const badgeLabel = enabled ? 'ACTIVE' : 'DISABLED';
  return (
    <div
      style={{
        display: 'flex',
        gap: '10px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--color-border)',
        opacity: pending ? 0.5 : 1,
        background: enabled ? 'transparent' : 'rgba(107, 114, 128, 0.08)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={readonly || pending}
        title={
          readonly
            ? 'plugin skill — managed by the plugin manager'
            : enabled
              ? 'Click to disable model auto-invocation'
              : 'Click to re-enable model auto-invocation'
        }
        style={{
          all: 'unset',
          flexShrink: 0,
          alignSelf: 'flex-start',
          padding: '3px 8px',
          marginTop: 2,
          background: badgeBg,
          color: '#fff',
          fontSize: 10,
          fontWeight: 'bold',
          letterSpacing: '0.05em',
          fontFamily: 'var(--font-pixel)',
          border: '1px solid var(--color-border)',
          cursor: readonly || pending ? 'not-allowed' : 'pointer',
          minWidth: 64,
          textAlign: 'center',
        }}
      >
        {badgeLabel}
      </button>
      <div style={{ display: 'none' }}>
        {/* legacy checkbox kept for a11y; the visible toggle is the badge above */}
        <input
          type="checkbox"
          checked={enabled}
          disabled={readonly || pending}
          onChange={onToggle}
          title={
            readonly
              ? 'plugin skill — managed by the plugin manager'
              : skill.plugin
                ? enabled
                  ? 'disable model auto-invocation (warning: a plugin update can revert this)'
                  : 're-enable model auto-invocation (warning: a plugin update can revert this)'
                : enabled
                  ? 'click to disable model auto-invocation'
                  : 'click to re-enable model auto-invocation'
          }
          style={{ cursor: readonly ? 'not-allowed' : 'pointer' }}
        />
      </div>
      <button
        type="button"
        onClick={onView}
        title="View SKILL.md content"
        style={{
          all: 'unset',
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          cursor: 'pointer',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px' }}>
            {skill.plugin && <span style={{ opacity: 0.6 }}>{skill.plugin}:</span>}
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
          {/* The big ACTIVE/DISABLED badge on the left already shows
              this — no need for a redundant inline pill. */}
        </div>
        {skill.description && (
          <div style={{ fontSize: '11px', opacity: 0.7, lineHeight: 1.4 }}>{skill.description}</div>
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
      </button>
      {!isPlugin && (
        <button
          type="button"
          onClick={onDelete}
          title="Delete this skill (removes the directory)"
          style={{
            ...iconBtnStyle,
            padding: '2px 8px',
            fontSize: 11,
            color: 'var(--color-danger)',
            borderColor: 'var(--color-danger)',
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function SkillViewer({
  skill,
  onClose,
}: {
  skill: SkillInfo;
  onClose: () => void;
}): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    void readSkillFile(skill.path)
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [skill.path]);

  // Strip the YAML frontmatter for the rendered view — the metadata is
  // already shown in the header. Body-only is what the user wants to read.
  const body = useMemo(() => {
    if (content == null) return '';
    const t = content.trimStart();
    if (!t.startsWith('---')) return content;
    const after = t.slice(3);
    const close = after.indexOf('\n---');
    if (close < 0) return content;
    return after.slice(close + 4).trimStart();
  }, [content]);

  return (
    <div
      role="dialog"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          width: 'min(720px, 92vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '2px solid var(--color-border)',
            background: 'var(--color-bg-dark)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 14, letterSpacing: '0.06em' }}>{skill.name}</span>
            <span
              style={{
                fontSize: 11,
                opacity: 0.55,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={skill.path}
            >
              {skill.scope}
              {skill.plugin ? ` · ${skill.plugin}` : ''} · {skill.path}
            </span>
          </div>
          <button type="button" onClick={onClose} style={iconBtnStyle}>
            ✕ close
          </button>
        </div>
        <div
          style={{
            padding: '12px 16px',
            overflow: 'auto',
            fontFamily: 'var(--font-pixel)',
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}
          {!error && content == null && <div style={{ opacity: 0.6 }}>loading…</div>}
          {!error && content != null && (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          )}
        </div>
      </div>
    </div>
  );
}

function MarketplaceSection({
  open,
  setOpen,
  installedNames,
  installCounter,
  installScope,
  projectPath,
  onInstalled,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  installedNames: Set<string>;
  installCounter: number;
  installScope: InstallScope;
  projectPath: string | null;
  onInstalled: () => void;
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<MarketplaceCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || catalog) return;
    let cancelled = false;
    void fetchMarketplaceCatalog()
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, catalog]);

  const onInstall = useCallback(
    async (entry: MarketplaceSkill, allowOverwrite = false): Promise<void> => {
      setInstallingId(entry.id);
      setError(null);
      try {
        const content = await fetchSkillContent(entry.url);
        await installSkillFromText({
          name: entry.name,
          content,
          scope: installScope,
          projectPath,
          overwrite: allowOverwrite,
        });
        onInstalled();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already exists/.test(msg)) {
          if (window.confirm(`${msg}\n\nReplace it?`)) {
            await onInstall(entry, true);
            return;
          }
        }
        console.warn('[Deepthix][SkillsPane] marketplace install failed', e);
        setError(msg);
      } finally {
        setInstallingId(null);
      }
    },
    [installScope, projectPath, onInstalled],
  );

  // installCounter forces a re-render so installedNames is fresh
  void installCounter;

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
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          all: 'unset',
          padding: '8px 12px',
          background: 'var(--color-bg-dark)',
          borderBottom: open ? '2px solid var(--color-border)' : 'none',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          cursor: 'pointer',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        <span style={{ fontSize: '13px', letterSpacing: '0.06em' }}>
          {open ? '▾' : '▸'} Marketplace
        </span>
        <span style={{ fontSize: '11px', opacity: 0.55 }}>
          {catalog ? `${catalog.skills.length} skills` : 'click to load'}
        </span>
      </button>
      {open && (
        <div style={{ padding: '12px' }}>
          {error && (
            <div style={{ color: 'var(--color-danger)', fontSize: 12, marginBottom: 8 }}>
              {error}
            </div>
          )}
          {!catalog && !error && <div style={{ opacity: 0.6, fontSize: 12 }}>loading catalog…</div>}
          {catalog && catalog.skills.length === 0 && (
            <div style={{ opacity: 0.6, fontSize: 12 }}>
              No skills in the catalog yet — submit one via PR to{' '}
              <code>docs/skills-marketplace.json</code>.
            </div>
          )}
          {catalog && catalog.skills.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {catalog.skills.map((entry) => {
                const installed = installedNames.has(entry.name);
                const busy = installingId === entry.id;
                return (
                  <div
                    key={entry.id}
                    style={{
                      display: 'flex',
                      gap: 10,
                      padding: '8px 10px',
                      background: 'var(--color-bg-dark)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontSize: 13 }}>{entry.name}</span>
                        {entry.author && (
                          <span style={{ fontSize: 10, opacity: 0.6 }}>by {entry.author}</span>
                        )}
                        {installed && (
                          <span
                            style={{
                              fontSize: 10,
                              padding: '1px 6px',
                              background: 'var(--color-bg)',
                              border: '1px solid var(--color-border)',
                              opacity: 0.7,
                            }}
                          >
                            installed
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
                        {entry.description}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void onInstall(entry)}
                      disabled={busy}
                      style={{
                        ...iconBtnStyle,
                        padding: '4px 10px',
                        fontSize: 11,
                      }}
                    >
                      {busy ? '…' : installed ? 'reinstall' : 'install'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
