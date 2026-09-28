/* eslint-disable deepthix/no-inline-colors, deepthix/pixel-font */
// WORKFLOW pane: named claude prompt recipes the user (or claude
// itself) can save and re-fire on demand. Two-column: workflow list
// on the left, edit/run/history on the right. Each Run opens a fresh
// claude session in the active project, ships the prompt as the first
// message, and appends a WorkflowRun record to the workflow's
// runs.jsonl log.
//
// Claude side: every claude session spawns with $DEEPTHIX_WORKFLOWS_PATH
// pointing at ~/.deepthix/workflows.json, so claude can Read it to
// list workflows and Edit/Write it to add/modify entries — no custom
// MCP tool needed for v1.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { UseProjectsResult } from '../hooks/useProjects';
import type { UseTerminalsResult } from '../hooks/useTerminals';
import {
  appendWorkflowRun,
  chatSendUserText,
  createWorkflow as cmdCreateWorkflow,
  deleteWorkflow as cmdDeleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  updateWorkflow as cmdUpdateWorkflow,
  type Workflow,
  type WorkflowRun,
  workflowsPath,
} from '../tauri/commands';
import type { Mode } from './TopTabs';

interface Props {
  terminals: UseTerminalsResult;
  projects: UseProjectsResult;
  onChangeMode: (m: Mode) => void;
}

const SAVE_DEBOUNCE_MS = 600;

export function WorkflowsPane({
  terminals,
  projects,
  onChangeMode,
}: Props): React.JSX.Element {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogPath, setCatalogPath] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listWorkflows();
      setWorkflows(list);
      setError(null);
      // Auto-select the first if none selected.
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][WorkflowsPane] list failed', e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void workflowsPath()
      .then(setCatalogPath)
      .catch((e) => console.warn('[Deepthix][WorkflowsPane] catalog path failed', e));
  }, [refresh]);

  // Poll every 5s so changes claude makes via Edit/Write on the JSON
  // catalog show up in the UI without requiring a manual refresh.
  useEffect(() => {
    const id = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) ?? null,
    [workflows, selectedId],
  );

  const onCreate = useCallback(async (): Promise<void> => {
    try {
      const wf = await cmdCreateWorkflow({
        name: 'New workflow',
        description: '',
        prompt: '',
        tags: [],
      });
      setWorkflows((prev) => [...prev, wf]);
      setSelectedId(wf.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][WorkflowsPane] create failed', e);
      setError(msg);
    }
  }, []);

  const onDelete = useCallback(
    async (id: string): Promise<void> => {
      try {
        await cmdDeleteWorkflow(id);
        setWorkflows((prev) => prev.filter((w) => w.id !== id));
        if (selectedId === id) setSelectedId(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[Deepthix][WorkflowsPane] delete failed', e);
        setError(msg);
      }
    },
    [selectedId],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        background: 'var(--color-bg)',
        fontFamily: 'var(--font-pixel)',
        color: 'var(--color-text)',
      }}
    >
      {/* Left column: workflow list */}
      <div
        style={{
          width: 280,
          minWidth: 240,
          borderRight: '2px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-bg-dark)',
        }}
      >
        <div
          className="dt-section-header"
          style={{
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>WORKFLOWS</span>
          <button
            type="button"
            onClick={() => void onCreate()}
            title="Create a new workflow"
            style={{
              padding: '2px 10px',
              background: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
              border: '2px solid var(--color-border)',
              boxShadow: 'var(--shadow-pixel)',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.6875rem',
              cursor: 'pointer',
            }}
          >
            + New
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
          {loading ? (
            <div style={{ padding: 12, fontSize: '0.6875rem', opacity: 0.6 }}>Loading…</div>
          ) : workflows.length === 0 ? (
            <div style={{ padding: 12, fontSize: '0.6875rem', opacity: 0.6, lineHeight: 1.5 }}>
              No workflow yet. Click <strong>+ New</strong> to add one, or have claude
              do it (the catalog file is at <code>$DEEPTHIX_WORKFLOWS_PATH</code>).
            </div>
          ) : (
            workflows.map((w) => (
              <WorkflowListItem
                key={w.id}
                workflow={w}
                selected={w.id === selectedId}
                onSelect={() => setSelectedId(w.id)}
              />
            ))
          )}
        </div>
        {catalogPath && (
          <div
            style={{
              padding: '8px 12px',
              borderTop: '1px solid var(--color-border)',
              fontSize: '0.5625rem',
              opacity: 0.5,
              wordBreak: 'break-all',
              lineHeight: 1.4,
            }}
            title="Claude can Read / Edit / Write this file directly to manage workflows"
          >
            📁 {catalogPath}
          </div>
        )}
      </div>

      {/* Right column: detail / edit / run / history */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {error && (
          <div
            style={{
              padding: '6px 10px',
              background: 'var(--color-danger)',
              color: 'var(--color-on-accent)',
              fontSize: '0.75rem',
            }}
          >
            {error}
          </div>
        )}
        {selected ? (
          <WorkflowEditor
            key={selected.id}
            workflow={selected}
            terminals={terminals}
            projects={projects}
            onChangeMode={onChangeMode}
            onLocalChange={(updated) => {
              setWorkflows((prev) =>
                prev.map((w) => (w.id === updated.id ? updated : w)),
              );
            }}
            onDelete={() => void onDelete(selected.id)}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              padding: 32,
              textAlign: 'center',
              opacity: 0.7,
            }}
          >
            <div style={{ fontSize: '2rem', opacity: 0.55 }}>🧰</div>
            <div style={{ fontSize: '0.875rem', fontWeight: 'bold' }}>
              Pick a workflow on the left
            </div>
            <div style={{ fontSize: '0.6875rem', opacity: 0.7, maxWidth: 380, lineHeight: 1.5 }}>
              Workflows are reusable claude prompt recipes — deploy steps, sweep
              scripts, weekly reports, anything you'd otherwise re-type.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Left list item
// ─────────────────────────────────────────────────────────────────────────

function WorkflowListItem({
  workflow,
  selected,
  onSelect,
}: {
  workflow: Workflow;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        padding: '8px 12px',
        cursor: 'pointer',
        borderLeft: `3px solid ${selected ? 'var(--color-accent)' : 'transparent'}`,
        background: selected ? 'var(--color-bg)' : 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span
        style={{
          fontSize: '0.75rem',
          fontWeight: selected ? 'bold' : 'normal',
          color: selected ? 'var(--color-accent-bright, var(--color-accent))' : 'var(--color-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {workflow.name || '(unnamed)'}
      </span>
      {workflow.description && (
        <span
          style={{
            fontSize: '0.625rem',
            opacity: 0.6,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {workflow.description}
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Right detail / edit / run / history
// ─────────────────────────────────────────────────────────────────────────

function WorkflowEditor({
  workflow,
  terminals,
  projects,
  onChangeMode,
  onLocalChange,
  onDelete,
}: {
  workflow: Workflow;
  terminals: UseTerminalsResult;
  projects: UseProjectsResult;
  onChangeMode: (m: Mode) => void;
  onLocalChange: (updated: Workflow) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description);
  const [prompt, setPrompt] = useState(workflow.prompt);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runError, setRunError] = useState<string | null>(null);

  // Keep the form in sync if the parent re-selects (or if claude
  // edited the catalog underneath us).
  useEffect(() => {
    setName(workflow.name);
    setDescription(workflow.description);
    setPrompt(workflow.prompt);
  }, [workflow.id, workflow.name, workflow.description, workflow.prompt]);

  // Debounced auto-save — no explicit Save button, change-and-go.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (
      name === workflow.name &&
      description === workflow.description &&
      prompt === workflow.prompt
    ) {
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void cmdUpdateWorkflow({ id: workflow.id, name, description, prompt })
        .then((updated) => {
          setSavedAt(Date.now());
          onLocalChange(updated);
        })
        .catch((e) => console.error('[Deepthix][WorkflowsPane] save failed', e));
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [name, description, prompt, workflow, onLocalChange]);

  // Run history — refreshes on workflow change + after a Run.
  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      const list = await listWorkflowRuns(workflow.id);
      setRuns(list);
    } catch (e) {
      console.warn('[Deepthix][WorkflowsPane] list runs failed', e);
    }
  }, [workflow.id]);
  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  const onRun = useCallback(async (): Promise<void> => {
    if (running) return;
    setRunError(null);
    const projectId = projects.activeProjectId;
    const project = projects.projects.find((p) => p.id === projectId) ?? null;
    if (!projectId || !project) {
      setRunError('Open a project first — workflows run inside the active project.');
      return;
    }
    if (!prompt.trim()) {
      setRunError('Workflow prompt is empty — nothing to run.');
      return;
    }
    setRunning(true);
    try {
      const entry = await terminals.open(projectId, project.path, 'claude');
      if (!entry) {
        setRunError('Failed to open a claude session.');
        return;
      }
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startedMs = Date.now();
      await appendWorkflowRun({
        run_id: runId,
        workflow_id: workflow.id,
        started_ms: startedMs,
        target_session_id: entry.sessionId ?? null,
        target_project_id: projectId,
        prompt,
        status: 'running',
      });
      // Ship the workflow prompt as the first user message. ChatPane
      // listens for deepthix:chat:user-text to show the bubble locally.
      await chatSendUserText(entry.id, prompt);
      window.dispatchEvent(
        new CustomEvent('deepthix:chat:user-text', {
          detail: { termId: entry.id, text: prompt },
        }),
      );
      // Mark the run as ok — the FE doesn't currently observe end-of-
      // turn from this scope, so "ok" means "shipped successfully" —
      // good enough for v1.
      void appendWorkflowRun({
        run_id: runId,
        workflow_id: workflow.id,
        started_ms: startedMs,
        ended_ms: Date.now(),
        target_session_id: entry.sessionId ?? null,
        target_project_id: projectId,
        prompt,
        status: 'ok',
      });
      void refreshRuns();
      // Hop the user into the SESSIONS view so they see it streaming.
      onChangeMode('sessions');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][WorkflowsPane] run failed', e);
      setRunError(msg);
    } finally {
      setRunning(false);
    }
  }, [
    running,
    prompt,
    workflow.id,
    projects.activeProjectId,
    projects.projects,
    terminals,
    onChangeMode,
    refreshRuns,
  ]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header: name + save indicator + run + delete */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '2px solid var(--color-border)',
          background: 'var(--color-bg-dark)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workflow name"
          style={{
            flex: 1,
            padding: '6px 8px',
            background: 'var(--color-bg)',
            border: '2px solid var(--color-border)',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.875rem',
            fontWeight: 'bold',
          }}
        />
        <span
          style={{
            fontSize: '0.625rem',
            opacity: 0.55,
            minWidth: 70,
            textAlign: 'right',
          }}
          title="Auto-save status"
        >
          {savedAt ? `saved ${formatTimeAgo(savedAt)}` : 'auto-save on'}
        </span>
        <button
          type="button"
          onClick={() => void onRun()}
          disabled={running || !prompt.trim()}
          title="Run this workflow now"
          style={{
            padding: '6px 14px',
            background: running || !prompt.trim() ? 'transparent' : 'var(--color-accent)',
            color: running || !prompt.trim() ? 'inherit' : 'var(--color-on-accent)',
            border: '2px solid var(--color-border)',
            boxShadow: running || !prompt.trim() ? 'none' : 'var(--shadow-pixel)',
            cursor: running || !prompt.trim() ? 'default' : 'pointer',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.75rem',
            fontWeight: 'bold',
            opacity: running ? 0.5 : 1,
          }}
        >
          {running ? '…' : '▶ Run'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete this workflow"
          style={{
            padding: '6px 10px',
            background: 'transparent',
            color: 'var(--color-danger)',
            border: '2px solid var(--color-border)',
            cursor: 'pointer',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.75rem',
          }}
        >
          ✗
        </button>
      </div>

      {/* Body: description + prompt + history */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Description" hint="Optional — what this workflow does in one line.">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-liner description"
            style={{
              width: '100%',
              padding: '6px 8px',
              background: 'var(--color-bg-dark)',
              border: '2px solid var(--color-border)',
              color: 'var(--color-text)',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.75rem',
              boxSizing: 'border-box',
            }}
          />
        </Field>

        <Field
          label="Prompt"
          hint="The exact message claude will receive when you click Run. Be specific."
          flex
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what claude should do…"
            rows={10}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: 'var(--color-bg-dark)',
              border: '2px solid var(--color-border)',
              color: 'var(--color-text)',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.75rem',
              lineHeight: 1.5,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </Field>

        {runError && (
          <div
            style={{
              padding: '6px 10px',
              border: '2px solid var(--color-danger)',
              color: 'var(--color-danger)',
              fontSize: '0.6875rem',
            }}
          >
            ✗ {runError}
          </div>
        )}

        <div>
          <div
            style={{
              fontSize: '0.6875rem',
              opacity: 0.7,
              marginBottom: 6,
              letterSpacing: '0.05em',
            }}
          >
            HISTORY · {runs.length} run{runs.length === 1 ? '' : 's'}
          </div>
          {runs.length === 0 ? (
            <div style={{ fontSize: '0.6875rem', opacity: 0.5, padding: '8px 10px' }}>
              No runs yet. Hit ▶ Run to fire this workflow.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {runs.slice(0, 30).map((r) => (
                <RunRow key={r.run_id} run={r} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: WorkflowRun }): React.JSX.Element {
  const elapsed = run.ended_ms != null ? run.ended_ms - run.started_ms : null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: 'var(--color-bg-dark)',
        border: '1px solid var(--color-border)',
        fontSize: '0.6875rem',
      }}
    >
      <StatusBadge status={run.status} />
      <span style={{ opacity: 0.85 }}>{new Date(run.started_ms).toLocaleString()}</span>
      {elapsed != null && (
        <span style={{ opacity: 0.55 }}>· {(elapsed / 1000).toFixed(1)}s</span>
      )}
      {run.target_session_id && (
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '0.625rem',
            opacity: 0.5,
            fontFamily: 'Menlo, Consolas, monospace',
          }}
          title={run.target_session_id}
        >
          {run.target_session_id.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const color =
    status === 'ok'
      ? 'var(--color-status-success, #34d399)'
      : status === 'error'
        ? 'var(--color-danger)'
        : status === 'interrupted'
          ? 'var(--color-warning, #f59e0b)'
          : 'var(--color-accent)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        background: 'var(--color-bg)',
        border: `1px solid ${color}`,
        color,
        fontSize: '0.5625rem',
        letterSpacing: '0.05em',
        fontWeight: 'bold',
      }}
    >
      {status.toUpperCase()}
    </span>
  );
}

function Field({
  label,
  hint,
  children,
  flex,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  flex?: boolean;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: flex ? 1 : undefined, minHeight: 0 }}>
      <div style={{ fontSize: '0.6875rem', fontWeight: 'bold', letterSpacing: '0.04em', opacity: 0.85 }}>
        {label}
      </div>
      {hint && (
        <div style={{ fontSize: '0.625rem', opacity: 0.55, marginBottom: 2 }}>{hint}</div>
      )}
      {children}
    </div>
  );
}

function formatTimeAgo(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}
