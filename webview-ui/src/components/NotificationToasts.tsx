/* eslint-disable deepthix/no-inline-colors */
// Top-right stacked toast notifications. Subscribes to the
// `deepthix-notification` Tauri event (fed by Tauri commands AND the
// JsonlWatcher on ~/.deepthix/notifications.jsonl, which the
// deepthix-mcp sidecar writes into).
//
// Each toast auto-dismisses after AUTO_DISMISS_MS unless the user
// hovers it. Click anywhere on the toast (except the × button) to
// keep it open until manually dismissed — useful for logs you want
// to read in detail.

import { useCallback, useEffect, useRef, useState } from 'react';

import { listRecentNotifications, type NotificationRecord } from '../tauri/commands';
import { onNotification } from '../tauri/events';

interface ToastEntry extends NotificationRecord {
  /** Local-only id so React can key + remove individual toasts. */
  uid: number;
  /** Click-to-pin state — true = no auto-dismiss. */
  pinned: boolean;
}

const MAX_VISIBLE = 5;
const AUTO_DISMISS_MS = 6000;

/**
 * Headless renderer — mounts no chrome of its own when there's nothing
 * to show. Rendered once at the App root so all sources share the same
 * stack.
 */
export function NotificationToasts(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const uidRef = useRef(1);

  const push = useCallback((n: NotificationRecord): void => {
    const uid = uidRef.current++;
    setToasts((prev) => {
      const next = [...prev, { ...n, uid, pinned: false }];
      // Hard cap — drop the oldest if we've blown past MAX_VISIBLE.
      // The user already missed the older ones if they accumulated this fast.
      if (next.length > MAX_VISIBLE) next.splice(0, next.length - MAX_VISIBLE);
      return next;
    });
  }, []);

  const dismiss = useCallback((uid: number): void => {
    setToasts((prev) => prev.filter((t) => t.uid !== uid));
  }, []);

  const togglePin = useCallback((uid: number): void => {
    setToasts((prev) =>
      prev.map((t) => (t.uid === uid ? { ...t, pinned: !t.pinned } : t)),
    );
  }, []);

  // Subscribe to live notifications from the Rust side.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onNotification((n) => {
      console.info('[Deepthix][NotificationToasts] received', {
        title: n.title,
        kind: n.kind,
        source: n.source,
      });
      push(n);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => {
        console.error('[Deepthix][NotificationToasts] subscribe failed', err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [push]);

  // On startup: backfill anything from the JSONL we missed while the app
  // was closed. Bounded — 5 most recent only, so we don't drown the user.
  useEffect(() => {
    let cancelled = false;
    void listRecentNotifications(5)
      .then((rows) => {
        if (cancelled) return;
        // Only backfill notifications from the last 24h — anything older
        // is probably already obsolete by the time the user reopens.
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        rows.filter((r) => r.ts_ms >= cutoff).forEach((r) => push(r));
      })
      .catch((err) => {
        console.warn('[Deepthix][NotificationToasts] backfill failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [push]);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 200,
        maxWidth: 380,
        width: 'min(380px, 90vw)',
        // Don't capture pointer events on the empty space between toasts
        // — only the toast cards themselves are interactive.
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <Toast
          key={t.uid}
          toast={t}
          onDismiss={() => dismiss(t.uid)}
          onTogglePin={() => togglePin(t.uid)}
        />
      ))}
    </div>
  );
}

function Toast({
  toast,
  onDismiss,
  onTogglePin,
}: {
  toast: ToastEntry;
  onDismiss: () => void;
  onTogglePin: () => void;
}): React.JSX.Element {
  // Auto-dismiss timer — paused while pinned. We re-arm whenever pin
  // toggles off so a freshly-unpinned toast still gets its full window.
  useEffect(() => {
    if (toast.pinned) return;
    const id = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast.pinned, onDismiss]);

  const palette = kindPalette(toast.kind);
  const icon = kindIcon(toast.kind);

  return (
    <div
      onClick={onTogglePin}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onTogglePin();
      }}
      title={toast.pinned ? 'Click to un-pin (auto-dismiss in 6s)' : 'Click to pin'}
      className="dt-chat-msg"
      style={{
        background: palette.bg,
        color: palette.fg,
        border: `2px solid ${palette.border}`,
        borderLeft: `4px solid ${palette.border}`,
        boxShadow: 'var(--shadow-pixel)',
        padding: '10px 12px',
        fontFamily: 'var(--font-pixel)',
        fontSize: '12px',
        cursor: 'pointer',
        pointerEvents: 'auto',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        position: 'relative',
        opacity: toast.pinned ? 1 : 0.97,
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0, marginTop: -1 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontWeight: 'bold',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {toast.title}
          </span>
          {toast.pinned && <span style={{ fontSize: 10, opacity: 0.7 }}>📌</span>}
        </div>
        {toast.body && (
          <span style={{ opacity: 0.9, lineHeight: 1.35, wordBreak: 'break-word' }}>
            {toast.body}
          </span>
        )}
        {toast.source && (
          <span style={{ fontSize: 10, opacity: 0.55 }}>{toast.source}</span>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation(); // don't pin when closing
          onDismiss();
        }}
        title="Dismiss"
        style={{
          background: 'transparent',
          color: palette.fg,
          border: 'none',
          padding: '0 4px',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          opacity: 0.7,
        }}
      >
        ×
      </button>
    </div>
  );
}

function kindPalette(kind: NotificationRecord['kind']): {
  bg: string;
  fg: string;
  border: string;
} {
  switch (kind) {
    case 'success':
      return {
        bg: 'var(--color-success, #34d399)',
        fg: 'var(--color-bg-dark)',
        border: 'var(--color-border)',
      };
    case 'warn':
      return {
        bg: 'var(--color-warning, #f59e0b)',
        fg: 'var(--color-bg-dark)',
        border: 'var(--color-border)',
      };
    case 'error':
      return {
        bg: 'var(--color-danger)',
        fg: 'var(--color-bg-dark)',
        border: 'var(--color-border)',
      };
    case 'info':
    default:
      return {
        bg: 'var(--color-bg-dark)',
        fg: 'var(--color-text)',
        border: 'var(--color-border)',
      };
  }
}

function kindIcon(kind: NotificationRecord['kind']): string {
  switch (kind) {
    case 'success':
      return '✓';
    case 'warn':
      return '⚠';
    case 'error':
      return '✗';
    case 'info':
    default:
      return 'ℹ';
  }
}
