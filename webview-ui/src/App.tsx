import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ProcessPane, SessionsPane } from './components/BottomPanel';
import { FilesPane } from './components/FilesPane';
import { MemoryPane } from './components/MemoryPane';
import { NotificationToasts } from './components/NotificationToasts';
import { OverviewPane } from './components/OverviewPane';
import { SchedulesPane } from './components/SchedulesPane';
// SessionsTopArea import removed — Coach pane was unmounted from the
// Sessions view per user request to give the chat the full height.
import { SettingsPane } from './components/SettingsPane';
import { Sidebar } from './components/Sidebar';
import { SkillsPane } from './components/SkillsPane';
import { TerminalDropTarget } from './components/TerminalDropTarget';
import { type Mode, TopTabs } from './components/TopTabs';
import { UpdaterBanner } from './components/UpdaterBanner';
import { UsagePane } from './components/UsagePane';
import { VariablesPane } from './components/VariablesPane';
import { VoiceRecorder } from './components/VoiceRecorder';
import { Welcome } from './components/Welcome';
import { WorkflowsPane } from './components/WorkflowsPane';
import { useFileTree } from './hooks/useFileTree';
import { useGlobalConfig } from './hooks/useGlobalConfig';
import { useOpenFiles } from './hooks/useOpenFiles';
import { useProjects } from './hooks/useProjects';
import { useTerminals } from './hooks/useTerminals';
import { isTauriRuntime } from './runtime';
import { setActiveProjectId, setActiveProjectPath, setOnOpenTerminal } from './tauriApi';

const MODE_STORAGE_KEY = 'deepthix.mode';

const VALID_MODES: ReadonlyArray<Mode> = [
  'overview',
  'sessions',
  'process',
  'memory',
  'files',
  'skills',
  'schedule',
  'workflow',
  'variables',
  'settings',
];

function App(): React.JSX.Element {
  const projects = useProjects();
  const fileTree = useFileTree(projects.activeProject?.path ?? null);
  const terminals = useTerminals();
  const openFiles = useOpenFiles(projects.activeProjectId);
  // Global app config (font/zoom for terminals, etc) — lives in
  // ~/.deepthix/config.json. Loaded once at boot, mutations debounce-write.
  const globalConfig = useGlobalConfig();

  // Top-level mode: which content fills the right pane.
  const [mode, setMode] = useState<Mode>(() => {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored && (VALID_MODES as readonly string[]).includes(stored)) {
      return stored as Mode;
    }
    return 'sessions';
  });
  useEffect(() => {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  console.log('[Deepthix][App] render', {
    projectsCount: projects.projects.length,
    activeProjectId: projects.activeProjectId,
    activeProjectPath: projects.activeProject?.path ?? null,
    terminalsCount: terminals.terminals.length,
    mode,
    globalConfigLoaded: globalConfig.loaded,
  });

  // Keep the postMessage bridge in sync with the active project (used by
  // saveLayout — kept around in case future per-project state lands).
  useEffect(() => {
    setActiveProjectId(projects.activeProjectId);
  }, [projects.activeProjectId]);

  useEffect(() => {
    setActiveProjectPath(projects.activeProject?.path ?? null);
  }, [projects.activeProject?.path]);

  // The legacy `+ Agent` button (still wired in the BottomToolbar from
  // pixel-agents code) is gone; users now spawn agents via the Welcome
  // screen / inline button. Keep the bridge handler in case any leftover
  // postMessage call site still fires it, so it doesn't crash.
  useEffect(() => {
    setOnOpenTerminal((cwd, kind) => {
      const projectId = projects.activeProjectId;
      if (!projectId) {
        console.warn('[Deepthix][App] openTerminal dropped — no active project');
        return;
      }
      console.debug('[Deepthix][App] openTerminal handler invoked', { projectId, cwd, kind });
      void terminals.open(projectId, cwd, kind);
    });
    return () => setOnOpenTerminal(null);
  }, [terminals, projects.activeProjectId]);

  // The TamagotchiView reads agent activity from window message events. The
  // existing JSONL parser in useTerminals already dispatches those events.
  // No additional bridging needed for the per-project visualization.

  // Auto-resume persisted sessions for EVERY known project — not just
  // the active one. This way a user switching projects doesn't have to
  // wait for the resume effect to fire on the new project, and sessions
  // from background projects keep ticking even when the user is looking
  // at another one.
  //
  // resumeProject's "already loaded" guard checks `terminalsRef.current`,
  // which is only updated AFTER setTerminals flushes — so two parallel
  // calls for the same project both pass the guard and double-spawn the
  // sessions. We track an in-flight set HERE to prevent that, and we
  // intentionally do NOT depend on `terminals` (which changes reference
  // on every state update and would re-fire this effect mid-resume).
  const resumeStartedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const p of projects.projects) {
      if (resumeStartedRef.current.has(p.id)) continue;
      resumeStartedRef.current.add(p.id);
      void terminals.resumeProject(p.id);
    }
    // Drop ids that no longer correspond to a known project so a
    // remove+re-add cycle re-resumes on the second add.
    const known = new Set(projects.projects.map((p) => p.id));
    for (const id of [...resumeStartedRef.current]) {
      if (!known.has(id)) resumeStartedRef.current.delete(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.projects]);

  // Tauri runtime indicator (compile-time presence check; logged once).
  useEffect(() => {
    console.log('[Deepthix][App] runtime', { isTauriRuntime });
  }, []);

  const hasProjects = projects.projects.length > 0;

  const SKIP_PERMS_KEY = 'deepthix.skipPermissions';
  const [skipPerms, setSkipPerms] = useState<boolean>(() => {
    return localStorage.getItem(SKIP_PERMS_KEY) === 'true';
  });
  useEffect(() => {
    localStorage.setItem(SKIP_PERMS_KEY, String(skipPerms));
  }, [skipPerms]);

  const onSpawnAgent = (): void => {
    const projectId = projects.activeProjectId;
    const cwd = projects.activeProject?.path;
    if (!projectId || !cwd) return;
    console.debug('[Deepthix][App] spawn session', { projectId, cwd, skipPerms });
    void terminals.open(projectId, cwd, 'claude', undefined, { skipPermissions: skipPerms });
  };

  // Sidebar → open a session: switch project when needed, focus the chat
  // tab, and make sure the SESSIONS view is showing.
  const onOpenSession = useCallback(
    (projectId: string, termId: string): void => {
      if (projectId !== projects.activeProjectId) void projects.switchProject(projectId);
      terminals.setActive(termId);
      setMode('sessions');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects.activeProjectId, projects.switchProject, terminals.setActive],
  );

  // Content-search hit on a transcript with no session entry yet: open it
  // as a new session tab resuming that conversation.
  const onResumeSession = useCallback(
    (projectId: string, sessionId: string): void => {
      const project = projects.projects.find((p) => p.id === projectId);
      if (!project) return;
      if (projectId !== projects.activeProjectId) void projects.switchProject(projectId);
      setMode('sessions');
      void terminals
        .open(projectId, project.path, 'claude', 'Conversation retrouvée', { resumeSessionId: sessionId })
        .then((entry) => {
          if (entry) terminals.setActive(entry.id);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects.projects, projects.activeProjectId, projects.switchProject, terminals.open, terminals.setActive],
  );

  const onOpenSettings = useCallback((): void => {
    console.debug('[Deepthix][App] open settings');
    setMode('settings');
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        background: 'var(--color-bg)',
      }}
    >
      <Sidebar
        projects={projects}
        terminals={terminals.terminals}
        onOpenSettings={onOpenSettings}
        settingsActive={mode === 'settings'}
        onOpenSession={onOpenSession}
        onResumeSession={onResumeSession}
        onNewSession={onSpawnAgent}
      />
      <div
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Top header bar: project name + mode tabs. Always present so the
            user can switch modes even when no project is open (modes that
            need a project will degrade gracefully). */}
        <TopTabs
          projectName={projects.activeProject?.name ?? null}
          mode={mode}
          onChangeMode={setMode}
        />
        {/* Right-pane body. The SESSIONS layout (TamagotchiView + the
            resizable terminal pane) MUST stay mounted across mode switches
            — unmounting it disposes every xterm instance and the user
            sees their terminals reset to whatever the last on-disk
            scrollback save was (up to 30s stale).
            Other modes (settings, overview, process, memory, files) render
            ON TOP of the sessions layout via an absolute overlay; flipping
            them on/off only flips a CSS display, so the sessions stay
            alive in the background.
            !hasProjects + Welcome screen: still gated on the project list
            (no terminal exists when no project is open). */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* SESSIONS layout — always mounted when at least one project
              exists, hidden via display:none when another mode is active. */}
          {hasProjects && (
            <div
              style={{
                display: mode === 'sessions' ? 'flex' : 'none',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
                position: 'relative',
              }}
            >
              <SessionsPane
                terminals={terminals}
                projectId={projects.activeProjectId}
                globalConfig={globalConfig.config}
                updateGlobalConfig={globalConfig.update}
              />
              {/* + Session button + skip-perms toggle — floating overlay
                  in the top-right corner of the SESSIONS view so the
                  chat below can use the full height. */}
              <div
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 12,
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  zIndex: 6,
                }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'var(--color-bg-dark)',
                    border: '2px solid var(--color-border)',
                    boxShadow: 'var(--shadow-pixel)',
                    padding: '4px 8px',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  title="Pass --dangerously-skip-permissions to new sessions"
                >
                  <input
                    type="checkbox"
                    checked={skipPerms}
                    onChange={(e) => setSkipPerms(e.target.checked)}
                  />
                  skip perms
                </label>
                <button
                  type="button"
                  onClick={onSpawnAgent}
                  style={{
                    padding: '6px 12px',
                    background: 'var(--color-accent)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    color: 'var(--color-on-accent)',
                    border: '2px solid var(--color-border)',
                    boxShadow: 'var(--shadow-pixel)',
                    fontFamily: 'var(--font-pixel)',
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                  }}
                >
                  <Plus size="1.1em" strokeWidth={2} aria-hidden />
                  <span>New session</span>
                </button>
              </div>
            </div>
          )}

          {/* Other modes — render as overlay so toggling between them
              doesn't tear down the SESSIONS layout. Each is wrapped in a
              flex-column container that fills the parent. */}
          {mode === 'settings' && (
            <ModeOverlay>
              <SettingsPane globalConfig={globalConfig} />
            </ModeOverlay>
          )}
          {mode === 'overview' && (
            <ModeOverlay>
              <OverviewPane terminals={terminals} projects={projects} onChangeMode={setMode} />
            </ModeOverlay>
          )}
          {mode !== 'sessions' && mode !== 'overview' && mode !== 'settings' && !hasProjects && (
            <ModeOverlay>
              <Welcome onOpenFolder={() => void projects.openAndAddProject()} />
            </ModeOverlay>
          )}
          {hasProjects && mode === 'process' && (
            <ModeOverlay>
              <ProcessPane projectPath={projects.activeProject?.path ?? null} />
            </ModeOverlay>
          )}
          {hasProjects && mode === 'memory' && (
            <ModeOverlay>
              <MemoryPane projectPath={projects.activeProject?.path ?? null} />
            </ModeOverlay>
          )}
          {hasProjects && mode === 'files' && (
            <ModeOverlay>
              <FilesPane
                projectPath={projects.activeProject?.path ?? null}
                fileTree={fileTree}
                openFiles={openFiles}
              />
            </ModeOverlay>
          )}
          {mode === 'usage' && (
            <ModeOverlay>
              <UsagePane />
            </ModeOverlay>
          )}
          {mode === 'skills' && (
            <ModeOverlay>
              <SkillsPane projectPath={projects.activeProject?.path ?? null} />
            </ModeOverlay>
          )}
          {mode === 'schedule' && (
            <ModeOverlay>
              <SchedulesPane terminals={terminals} />
            </ModeOverlay>
          )}
          {mode === 'workflow' && (
            <ModeOverlay>
              <WorkflowsPane
                terminals={terminals}
                projects={projects}
                onChangeMode={setMode}
              />
            </ModeOverlay>
          )}
          {mode === 'variables' && (
            <ModeOverlay>
              <VariablesPane />
            </ModeOverlay>
          )}
        </div>
      </div>
      {/* Push-to-talk voice → terminal. Hold ⌘M to record, release to
          transcribe via local whisper.cpp + inject into the active
          terminal. Always mounted; renders nothing in idle state. */}
      <VoiceRecorder
        activeTermId={terminals.activeId}
        activeProjectId={projects.activeProjectId}
        terminals={terminals.terminals.map((t) => ({
          id: t.id,
          label: t.label,
          cwd: t.cwd,
          kind: t.kind,
          projectId: t.projectId,
        }))}
      />
      {/* Top-right toast stack — driven by `deepthix-notification` events
          from Tauri commands AND the JsonlWatcher on
          ~/.deepthix/notifications.jsonl (which deepthix-mcp writes to). */}
      <NotificationToasts />
      {/* Auto-update banner: silent on launch, only paints itself if a
          newer version is available at the configured updater endpoint. */}
      <UpdaterBanner />
      {/* Drag a file from Finder onto the window → its absolute path is
          shell-quoted and char-by-char-injected into the active claude
          session's prompt. Picks the same target as VoiceRecorder. */}
      <TerminalDropTarget
        activeTermId={terminals.activeId}
        activeProjectId={projects.activeProjectId}
        terminals={terminals.terminals.map((t) => ({
          id: t.id,
          label: t.label,
          cwd: t.cwd,
          kind: t.kind,
          projectId: t.projectId,
        }))}
      />
    </div>
  );
}

/** Absolute-positioned overlay that fully covers the SESSIONS layout.
 *  Used by every non-sessions mode so switching back to SESSIONS doesn't
 *  remount the xterm instances (and lose live scrollback). */
function ModeOverlay({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
      }}
    >
      {children}
    </div>
  );
}

export default App;
