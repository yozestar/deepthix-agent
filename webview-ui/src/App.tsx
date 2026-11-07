import { useCallback, useEffect, useRef, useState } from 'react';

import { EquipePane } from './components/agents/EquipePane';
import { HomePane } from './components/agents/HomePane';
import { MissionsPane } from './components/agents/MissionsPane';
import { SavoirPane } from './components/agents/SavoirPane';
import { ProcessPane, SessionsPane } from './components/BottomPanel';
import { FilesPane } from './components/FilesPane';
import { MemoryPane } from './components/MemoryPane';
import { NotificationToasts } from './components/NotificationToasts';
import { OverviewPane } from './components/OverviewPane';
import { PairRequestDialog } from './components/PairRequestDialog';
import { RemoteDropZone } from './components/RemoteDropZone';
import { RemoteFolderPicker } from './components/RemoteFolderPicker';
import { SchedulesPane } from './components/SchedulesPane';
// SessionsTopArea import removed — Coach pane was unmounted from the
// Sessions view per user request to give the chat the full height.
import { SettingsPane } from './components/SettingsPane';
import { Rail } from './components/shell/Rail';
import { SpaceHeader } from './components/shell/SpaceHeader';
import { type SpaceId, spaceOf, spacesFor } from './components/shell/spaces';
import { Sidebar } from './components/Sidebar';
import { SkillsPane } from './components/SkillsPane';
import { TasksPane } from './components/TasksPane';
import { TerminalDropTarget } from './components/TerminalDropTarget';
import type { Mode } from './components/TopTabs';
import { UpdaterBanner } from './components/UpdaterBanner';
import { UsagePane } from './components/UsagePane';
import { VariablesPane } from './components/VariablesPane';
import { VoiceRecorder } from './components/VoiceRecorder';
import { Welcome } from './components/Welcome';
import { WorkflowsPane } from './components/WorkflowsPane';
import { useFileTree } from './hooks/useFileTree';
import { useFormFactor, useTouchViewport } from './hooks/useFormFactor';
import { useGlobalConfig } from './hooks/useGlobalConfig';
import { useOpenFiles } from './hooks/useOpenFiles';
import { useProjects } from './hooks/useProjects';
import { useRole } from './hooks/useRole';
import { useTerminals } from './hooks/useTerminals';
import { isRemoteRuntime, isTauriRuntime } from './runtime';
import { agentsApi } from './tauri/commands';
import { setActiveProjectId, setActiveProjectPath, setOnOpenTerminal } from './tauriApi';

const MODE_STORAGE_KEY = 'deepthix.mode';

const VALID_MODES: ReadonlyArray<Mode> = [
  'accueil',
  'savoir',
  'equipe',
  'missions',
  'usage',
  'overview',
  'sessions',
  'tasks',
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
    return 'accueil';
  });
  useEffect(() => {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  // Design v2: spaces (left rail) + role (administrator / collaborator).
  const { role, me, canPreview, preview, setPreview } = useRole();
  const allowedSpaces = spacesFor(role);
  const space = spaceOf(mode);
  const lastModeBySpace = useRef<Partial<Record<SpaceId, Mode>>>({});
  useEffect(() => {
    lastModeBySpace.current[space.id] = mode;
  }, [space.id, mode]);
  useEffect(() => {
    if (!allowedSpaces.some((s) => s.id === space.id)) setMode(allowedSpaces[0]?.modes[0] ?? 'sessions');
  }, [allowedSpaces, space.id]);
  const pickSpace = (id: SpaceId): void => {
    const target = allowedSpaces.find((s) => s.id === id);
    if (!target) return;
    setMode(lastModeBySpace.current[id] ?? target.modes[0]);
  };
  // Rail badge: decisions waiting (validations), refreshed every 15 s.
  const [pendingValidations, setPendingValidations] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      void agentsApi<{ validations: unknown[] }>('accueil')
        .then((h) => alive && setPendingValidations(h.validations.length))
        .catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

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

  const spawnSession = (skipPermissions: boolean): void => {
    const projectId = projects.activeProjectId;
    const cwd = projects.activeProject?.path;
    if (!projectId || !cwd) return;
    console.debug('[Deepthix][App] spawn session', { projectId, cwd, skipPermissions });
    void terminals.open(projectId, cwd, 'claude', undefined, { skipPermissions }).then((entry) => {
      if (entry) terminals.setActive(entry.id);
    });
  };
  const onSpawnAgent = (): void => spawnSession(skipPerms);

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

  // Task → the conversation it came from: same tab if open, else reopened
  // from the closed list, else opened from its transcript.
  const onOpenConversation = useCallback(
    async (projectId: string, sessionId: string, label: string): Promise<void> => {
      const project = projects.projects.find((p) => p.id === projectId);
      if (!project) return;
      if (projectId !== projects.activeProjectId) await projects.switchProject(projectId);
      setMode('sessions');
      // Load the project's tabs first, so an open tab is focused, not doubled.
      await terminals.resumeProject(projectId);
      if (terminals.closedForProject(projectId).some((c) => c.session_id === sessionId)) {
        terminals.reopen(projectId, sessionId);
      } else {
        terminals.openTranscript(projectId, project.path, sessionId, label || 'Conversation');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects.projects, projects.activeProjectId, projects.switchProject, terminals],
  );

  // Tab "Déplacer vers…": move the conversation to another project, then
  // follow it there so the user keeps working on it.
  const onMoveToProject = useCallback(
    async (termId: string, projectId: string): Promise<void> => {
      const target = projects.projects.find((p) => p.id === projectId);
      if (!target) throw new Error('Projet introuvable.');
      const newId = await terminals.moveToProject(termId, projectId, target.path);
      await projects.switchProject(projectId);
      terminals.setActive(newId);
      setMode('sessions');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects.projects, projects.switchProject, terminals.moveToProject, terminals.setActive],
  );

  const onOpenSettings = useCallback((): void => {
    console.debug('[Deepthix][App] open settings');
    setMode('settings');
  }, []);

  // Touch layouts (remote access from a phone): the sidebar becomes a
  // drawer that closes once the user picked something in it.
  const formFactor = useFormFactor();
  useTouchViewport(formFactor);
  const touch = formFactor !== 'desktop';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawerThen =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      setDrawerOpen(false);
      fn(...args);
    };

  const sidebar = (
    <Sidebar
      projects={projects}
      terminals={terminals.terminals}
      onOpenSettings={touch ? closeDrawerThen(onOpenSettings) : onOpenSettings}
      settingsActive={mode === 'settings'}
      onOpenSession={touch ? closeDrawerThen(onOpenSession) : onOpenSession}
      onResumeSession={touch ? closeDrawerThen(onResumeSession) : onResumeSession}
      onNewSession={touch ? closeDrawerThen(onSpawnAgent) : onSpawnAgent}
      fill={touch}
      onProjectPicked={touch ? () => setDrawerOpen(false) : undefined}
    />
  );

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        // Touch: pinned to the visual viewport so the iOS keyboard never
        // scrolls the app out of sight.
        ...(touch
          ? {
              position: 'fixed',
              top: 0,
              left: 0,
              height: 'var(--app-height, 100vh)',
              transform: 'translateY(var(--app-offset-top, 0px))',
            }
          : {}),
        background: 'var(--app-backdrop)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        boxSizing: 'border-box',
      }}
    >
      {!touch && (
        <Rail spaces={allowedSpaces} active={space.id} badges={{ missions: pendingValidations }} onPick={pickSpace} />
      )}
      {!touch && space.id === 'projets' && sidebar}
      {touch && drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 250, background: 'var(--color-backdrop)' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: 'min(88vw, 380px)',
              paddingTop: 'env(safe-area-inset-top)',
              background: 'var(--color-sidebar-bg)',
              boxShadow: 'var(--shadow-pixel)',
            }}
          >
            {sidebar}
          </div>
        </div>
      )}
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
        <SpaceHeader
          space={space}
          mode={mode}
          projectName={projects.activeProject?.name ?? null}
          onMode={setMode}
          canPreview={canPreview}
          preview={preview}
          onPreview={setPreview}
          onOpenMenu={touch ? () => setDrawerOpen(true) : undefined}
        />
        {touch && (
          <div className="dt-hide-when-keyboard" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 12px 8px' }}>
            {allowedSpaces.map((sp) => (
              <button
                key={sp.id}
                type="button"
                onClick={() => pickSpace(sp.id)}
                style={{
                  border: 'none',
                  borderRadius: 999,
                  padding: '6px 12px',
                  whiteSpace: 'nowrap',
                  background: sp.id === space.id ? 'var(--gradient-accent)' : 'var(--color-btn-bg)',
                  color: sp.id === space.id ? 'var(--color-on-accent)' : 'var(--color-text)',
                }}
              >
                {sp.emoji} {sp.label}
              </button>
            ))}
          </div>
        )}
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
                projectPath={projects.activeProject?.path ?? null}
                onNewSession={(skip) => spawnSession(skip)}
                skipPermissions={skipPerms}
                onToggleSkipPermissions={setSkipPerms}
                projects={projects.projects}
                onMoveToProject={onMoveToProject}
              />
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
              <OverviewPane
                terminals={terminals}
                projects={projects}
                onChangeMode={setMode}
                onOpenConversation={(pid, sid, label) => void onOpenConversation(pid, sid, label)}
              />
            </ModeOverlay>
          )}
          {mode === 'tasks' && (
            <ModeOverlay>
              <TasksPane
                projects={projects}
                onChangeMode={setMode}
                onOpenConversation={(pid, sid, label) => void onOpenConversation(pid, sid, label)}
                conversationLabel={(sid) => terminals.terminals.find((t) => t.sessionId === sid)?.label ?? null}
              />
            </ModeOverlay>
          )}
          {/* No project yet (fresh install): SESSIONS has nothing to mount
              either, so it gets the Welcome screen too instead of a blank pane.
              TASKS lists every project's tasks, so it stays reachable. */}
          {space.id === 'projets' && mode !== 'overview' && mode !== 'tasks' && !hasProjects && (
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
          {mode === 'accueil' && (
            <ModeOverlay>
              <HomePane role={role} myName={me?.nom ?? null} onGo={(w) => setMode(w)} />
            </ModeOverlay>
          )}
          {mode === 'savoir' && (
            <ModeOverlay>
              <SavoirPane />
            </ModeOverlay>
          )}
          {mode === 'equipe' && (
            <ModeOverlay>
              <EquipePane isAdmin={role === 'admin'} />
            </ModeOverlay>
          )}
          {mode === 'missions' && (
            <ModeOverlay>
              <MissionsPane />
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
          ~/.elyone/notifications.jsonl (which deepthix-mcp writes to). */}
      <NotificationToasts />
      <PairRequestDialog />
      {isRemoteRuntime && <RemoteFolderPicker />}
      {isRemoteRuntime && <RemoteDropZone activeTermId={terminals.activeId} />}
      {/* Auto-update banner: silent on launch, only paints itself if a
          newer version is available at the configured updater endpoint. */}
      {!isRemoteRuntime && <UpdaterBanner />}
      {/* Drag a file from Finder onto the window → its absolute path is
          shell-quoted and char-by-char-injected into the active claude
          session's prompt. Picks the same target as VoiceRecorder. */}
      {!isRemoteRuntime && (
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
      )}
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
        background: 'var(--app-backdrop)',
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
