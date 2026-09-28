/* eslint-disable deepthix/pixel-font */
// VARIABLES pane: shared key/value scratchpad both the user and claude
// can read + write. Storage at ~/.deepthix/variables.json. Claude
// sessions see $DEEPTHIX_VARIABLES_PATH as an env var; the global
// brief in ~/.claude/CLAUDE.md teaches them how to use it.
//
// UI: a flat table — key, value, description, updated_at, delete.
// Inline edit on focus, debounced auto-save on blur. + Add at the top.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  deleteVariable as cmdDeleteVariable,
  listVariables,
  setVariable as cmdSetVariable,
  type Variable,
  variablesPath,
} from '../tauri/commands';

const POLL_MS = 5_000;

export function VariablesPane(): React.JSX.Element {
  const [vars, setVars] = useState<Variable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogPath, setCatalogPath] = useState<string | null>(null);
  // Pending row for the "+ Add" form.
  const [draft, setDraft] = useState<{ key: string; value: string; description: string } | null>(
    null,
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listVariables();
      setVars(list);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Deepthix][VariablesPane] list failed', e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void variablesPath()
      .then(setCatalogPath)
      .catch((e) => console.warn('[Deepthix][VariablesPane] path failed', e));
  }, [refresh]);

  // Poll for changes claude makes via Read/Write on the JSON file.
  useEffect(() => {
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const onSaveDraft = useCallback(async (): Promise<void> => {
    if (!draft) return;
    const k = draft.key.trim();
    if (!k) {
      setError('key cannot be empty');
      return;
    }
    try {
      await cmdSetVariable({ key: k, value: draft.value, description: draft.description });
      setDraft(null);
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }, [draft, refresh]);

  const onDelete = useCallback(
    async (key: string): Promise<void> => {
      try {
        await cmdDeleteVariable(key);
        setVars((prev) => prev.filter((v) => v.key !== key));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      }
    },
    [],
  );

  const onUpdate = useCallback(
    async (key: string, patch: { value?: string; description?: string }): Promise<void> => {
      const cur = vars.find((v) => v.key === key);
      if (!cur) return;
      try {
        const saved = await cmdSetVariable({
          key,
          value: patch.value ?? cur.value,
          description: patch.description ?? cur.description,
        });
        setVars((prev) => prev.map((v) => (v.key === key ? saved : v)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      }
    },
    [vars],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg)',
        fontFamily: 'var(--font-pixel)',
        color: 'var(--color-text)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          background: 'var(--color-bg-dark)',
          borderBottom: '2px solid var(--color-border)',
        }}
      >
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              fontSize: '0.9375rem',
              fontWeight: 'bold',
              letterSpacing: '0.06em',
              color: 'var(--color-accent)',
            }}
          >
            VARIABLES
          </span>
          <span style={{ fontSize: '0.6875rem', opacity: 0.7 }}>
            Shared key/value state · both you and claude can read/write
          </span>
        </div>
        {!draft && (
          <button
            type="button"
            onClick={() => setDraft({ key: '', value: '', description: '' })}
            style={{
              padding: '6px 12px',
              background: 'var(--color-accent)',
              color: 'var(--color-bg-dark)',
              border: '2px solid var(--color-border)',
              boxShadow: 'var(--shadow-pixel)',
              fontFamily: 'var(--font-pixel)',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            + Add
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: '6px 16px',
            background: 'var(--color-danger)',
            color: 'var(--color-bg-dark)',
            fontSize: '0.75rem',
          }}
        >
          ✗ {error}
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16 }}>
        {loading ? (
          <div style={{ opacity: 0.6, fontSize: '0.75rem' }}>Loading…</div>
        ) : vars.length === 0 && !draft ? (
          <EmptyState onAdd={() => setDraft({ key: '', value: '', description: '' })} />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(160px, 1fr) minmax(220px, 2fr) minmax(180px, 2fr) auto',
              gap: 0,
              border: '2px solid var(--color-border)',
              background: 'var(--color-bg-dark)',
            }}
          >
            <HeaderCell>Key</HeaderCell>
            <HeaderCell>Value</HeaderCell>
            <HeaderCell>Description</HeaderCell>
            <HeaderCell> </HeaderCell>
            {draft && (
              <DraftRow
                draft={draft}
                onChange={setDraft}
                onSave={() => void onSaveDraft()}
                onCancel={() => setDraft(null)}
              />
            )}
            {vars.map((v) => (
              <VariableRow
                key={v.key}
                variable={v}
                onUpdate={(patch) => void onUpdate(v.key, patch)}
                onDelete={() => void onDelete(v.key)}
              />
            ))}
          </div>
        )}
      </div>

      {catalogPath && (
        <div
          style={{
            padding: '6px 16px 10px',
            fontSize: '0.5625rem',
            opacity: 0.55,
            wordBreak: 'break-all',
            lineHeight: 1.4,
            borderTop: '1px solid var(--color-border)',
            background: 'var(--color-bg-dark)',
          }}
          title="Claude can Read / Edit / Write this file directly via $DEEPTHIX_VARIABLES_PATH"
        >
          📁 {catalogPath} · also available to claude as
          <code style={{ marginLeft: 4 }}>$DEEPTHIX_VARIABLES_PATH</code>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function EmptyState({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
        padding: 40,
        textAlign: 'center',
        opacity: 0.85,
      }}
    >
      <div style={{ fontSize: '2rem', opacity: 0.55 }}>🗂</div>
      <div style={{ fontSize: '0.875rem', fontWeight: 'bold' }}>
        No variables yet
      </div>
      <div style={{ fontSize: '0.6875rem', opacity: 0.7, maxWidth: 420, lineHeight: 1.5 }}>
        Variables are a shared key/value scratchpad — pin context that should
        outlive a single conversation (sprint id, prod host, last deploy SHA…).
        Both you and claude can read or update them.
      </div>
      <button
        type="button"
        onClick={onAdd}
        style={{
          padding: '8px 18px',
          background: 'var(--color-accent)',
          color: 'var(--color-bg-dark)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          fontFamily: 'var(--font-pixel)',
          fontSize: '0.75rem',
          cursor: 'pointer',
        }}
      >
        + Add your first variable
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function HeaderCell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        padding: '8px 10px',
        fontSize: '0.625rem',
        fontWeight: 'bold',
        letterSpacing: '0.06em',
        opacity: 0.65,
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bg)',
      }}
    >
      {children}
    </div>
  );
}

function DraftRow({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: { key: string; value: string; description: string };
  onChange: (next: { key: string; value: string; description: string }) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const cellStyle: React.CSSProperties = {
    padding: '6px 8px',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg)',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '4px 6px',
    background: 'var(--color-bg-dark)',
    border: '1px solid var(--color-border)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-pixel)',
    fontSize: '0.75rem',
    boxSizing: 'border-box',
  };
  return (
    <>
      <div style={cellStyle}>
        <input
          autoFocus
          placeholder="key (e.g. current_sprint)"
          value={draft.key}
          onChange={(e) => onChange({ ...draft, key: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') onCancel();
          }}
          style={inputStyle}
        />
      </div>
      <div style={cellStyle}>
        <input
          placeholder="value"
          value={draft.value}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') onCancel();
          }}
          style={inputStyle}
        />
      </div>
      <div style={cellStyle}>
        <input
          placeholder="description (optional)"
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') onCancel();
          }}
          style={inputStyle}
        />
      </div>
      <div
        style={{
          ...cellStyle,
          display: 'flex',
          gap: 4,
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          onClick={onSave}
          title="Save (Enter)"
          style={{
            padding: '3px 8px',
            background: 'var(--color-accent)',
            color: 'var(--color-bg-dark)',
            border: '1px solid var(--color-border)',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.625rem',
            cursor: 'pointer',
          }}
        >
          ✓
        </button>
        <button
          type="button"
          onClick={onCancel}
          title="Cancel (Escape)"
          style={{
            padding: '3px 8px',
            background: 'transparent',
            color: 'inherit',
            border: '1px solid var(--color-border)',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.625rem',
            cursor: 'pointer',
          }}
        >
          ✗
        </button>
      </div>
    </>
  );
}

function VariableRow({
  variable,
  onUpdate,
  onDelete,
}: {
  variable: Variable;
  onUpdate: (patch: { value?: string; description?: string }) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(variable.value);
  const [description, setDescription] = useState(variable.description);
  // Keep in sync when the parent refreshes (claude edited the file).
  useEffect(() => {
    setValue(variable.value);
    setDescription(variable.description);
  }, [variable.value, variable.description]);

  // Debounce per-field commits so live edits don't hammer disk.
  const valueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (value === variable.value) return;
    if (valueTimerRef.current) clearTimeout(valueTimerRef.current);
    valueTimerRef.current = setTimeout(() => onUpdate({ value }), 500);
    return () => {
      if (valueTimerRef.current) clearTimeout(valueTimerRef.current);
    };
  }, [value, variable.value, onUpdate]);

  const descTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (description === variable.description) return;
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    descTimerRef.current = setTimeout(() => onUpdate({ description }), 500);
    return () => {
      if (descTimerRef.current) clearTimeout(descTimerRef.current);
    };
  }, [description, variable.description, onUpdate]);

  const cellStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: '1px solid var(--color-border)',
    fontSize: '0.75rem',
    display: 'flex',
    alignItems: 'center',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '3px 6px',
    background: 'transparent',
    border: '1px solid transparent',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-pixel)',
    fontSize: '0.75rem',
    boxSizing: 'border-box',
  };
  return (
    <>
      <div style={cellStyle}>
        <span
          style={{
            fontFamily: 'Menlo, Consolas, monospace',
            fontSize: '0.75rem',
            color: 'var(--color-accent)',
            wordBreak: 'break-all',
          }}
          title={`Updated ${new Date(variable.updated_ms).toLocaleString()}`}
        >
          {variable.key}
        </span>
      </div>
      <div style={cellStyle}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={inputStyle}
          onFocus={(e) => {
            (e.target as HTMLInputElement).style.border = '1px solid var(--color-border)';
            (e.target as HTMLInputElement).style.background = 'var(--color-bg-dark)';
          }}
          onBlur={(e) => {
            (e.target as HTMLInputElement).style.border = '1px solid transparent';
            (e.target as HTMLInputElement).style.background = 'transparent';
          }}
        />
      </div>
      <div style={cellStyle}>
        <input
          value={description}
          placeholder="—"
          onChange={(e) => setDescription(e.target.value)}
          style={inputStyle}
          onFocus={(e) => {
            (e.target as HTMLInputElement).style.border = '1px solid var(--color-border)';
            (e.target as HTMLInputElement).style.background = 'var(--color-bg-dark)';
          }}
          onBlur={(e) => {
            (e.target as HTMLInputElement).style.border = '1px solid transparent';
            (e.target as HTMLInputElement).style.background = 'transparent';
          }}
        />
      </div>
      <div style={{ ...cellStyle, justifyContent: 'flex-end', gap: 4 }}>
        <button
          type="button"
          onClick={onDelete}
          title="Delete this variable"
          style={{
            padding: '3px 8px',
            background: 'transparent',
            color: 'var(--color-danger)',
            border: '1px solid var(--color-border)',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.6875rem',
            cursor: 'pointer',
          }}
        >
          ✗
        </button>
      </div>
    </>
  );
}
