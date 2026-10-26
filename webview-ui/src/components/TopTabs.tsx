// Top header bar for the right pane: project name on the left, mode tabs
// (Overview / Sessions / Files / Process / Memory) on the right. The active
// mode controls which content App.tsx mounts in the rest of the right pane.
//
// `'settings'` is part of the `Mode` union but intentionally NOT shown in
// the top tab strip — the SETTINGS button at the top of the sidebar
// switches into it instead.

import type { LucideIcon } from 'lucide-react';
import {
  Brain,
  CalendarClock,
  Cpu,
  FolderOpen,
  FolderTree,
  Gauge,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Sparkles,
  Variable,
  Workflow,
} from 'lucide-react';

import type { FormFactor } from '../hooks/useFormFactor';
import { PlanUsageGauge } from './PlanUsageGauge';

export type Mode =
  | 'overview'
  | 'sessions'
  | 'process'
  | 'memory'
  | 'files'
  | 'usage'
  | 'skills'
  | 'schedule'
  | 'workflow'
  | 'variables'
  | 'settings';

interface Props {
  projectName: string | null;
  mode: Mode;
  onChangeMode: (m: Mode) => void;
  /** Touch layouts get a menu button (sidebar drawer) and icon-only tabs. */
  formFactor?: FormFactor;
  onOpenMenu?: () => void;
}

/** Visible top-tab modes, in display order. `'settings'` is filtered out.
 *  FILES and USAGE live here (moved out of the left sidebar per user
 *  request — the sidebar is now the projects-only scroll column). */
const VISIBLE_MODES: ReadonlyArray<Mode> = [
  'overview',
  'sessions',
  'files',
  'usage',
  'process',
  'memory',
  'skills',
  'schedule',
  'workflow',
  'variables',
];

/** Folded phone: the minimal set — sessions, project board, files. */
const PHONE_MODES: ReadonlyArray<Mode> = ['sessions', 'overview', 'files'];

/** Icon + human label per tab (sentence case instead of SHOUTING). */
const MODE_META: Record<Exclude<Mode, 'settings'>, { label: string; Icon: LucideIcon }> = {
  overview: { label: 'Overview', Icon: LayoutDashboard },
  sessions: { label: 'Sessions', Icon: MessagesSquare },
  files: { label: 'Files', Icon: FolderTree },
  usage: { label: 'Usage', Icon: Gauge },
  process: { label: 'Process', Icon: Cpu },
  memory: { label: 'Memory', Icon: Brain },
  skills: { label: 'Skills', Icon: Sparkles },
  schedule: { label: 'Schedule', Icon: CalendarClock },
  workflow: { label: 'Workflows', Icon: Workflow },
  variables: { label: 'Variables', Icon: Variable },
};

export function TopTabs({
  projectName,
  mode,
  onChangeMode,
  formFactor = 'desktop',
  onOpenMenu,
}: Props): React.JSX.Element {
  const touch = formFactor !== 'desktop';
  const modes = formFactor === 'phone' ? PHONE_MODES : VISIBLE_MODES;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '6px 12px',
        background: 'var(--color-bg-dark)',
        borderBottom: '2px solid var(--color-border)',
        fontFamily: 'var(--font-pixel)',
        flexShrink: 0,
        minHeight: '44px',
        // Tablet: tabs move to their own full-width row below. Phone keeps a
        // single compact row (only 3 tabs).
        flexWrap: formFactor === 'tablet' ? 'wrap' : undefined,
        rowGap: touch ? '4px' : undefined,
      }}
    >
      {touch && onOpenMenu && (
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Projets et sessions"
          style={{
            minWidth: 44,
            minHeight: 44,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            color: 'var(--color-text)',
            border: 'none',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <Menu size="1.4em" strokeWidth={1.75} aria-hidden />
        </button>
      )}
      {/* Left: project name. No more heavy box — just a clean label with a
          discrete "▸" path hint on hover. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 8px',
          fontSize: '0.9375rem',
          letterSpacing: '0.04em',
          maxWidth: formFactor === 'phone' ? undefined : touch ? '30%' : '40%',
          minWidth: touch ? 0 : '120px',
          flex: formFactor === 'phone' ? 1 : undefined,
          flexShrink: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          fontWeight: 'bold',
          color: 'var(--color-text)',
        }}
        title={projectName ?? 'Elyone AI Desktop Agent'}
      >
        <FolderOpen
          size="1.05em"
          strokeWidth={1.75}
          style={{ color: 'var(--color-accent)', alignSelf: 'center', flexShrink: 0 }}
          aria-hidden
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {projectName ?? 'Elyone AI Desktop Agent'}
        </span>
      </div>

      {/* Plan consumption (5 h session + weekly) — click opens Usage. */}
      {formFactor !== 'phone' && <PlanUsageGauge onOpenUsage={() => onChangeMode('usage')} />}

      {/* Right: mode tabs. Active tab gets an underline-style accent
          instead of full-fill — calmer chrome. */}
      {/* Tabs scroll horizontally instead of squeezing the project name
          when the window is narrow or the UI text size is large. */}
      <div
        style={{
          display: 'flex',
          gap: '2px',
          minWidth: 0,
          overflowX: 'auto',
          scrollbarWidth: 'none',
          ...(formFactor === 'tablet' ? { order: 3, width: '100%', justifyContent: 'space-between' } : {}),
        }}
      >
        {modes.map((m) => {
          const active = m === mode;
          const meta = MODE_META[m as Exclude<Mode, 'settings'>];
          const Icon = meta.Icon;
          return (
            <button
              key={m}
              type="button"
              onClick={() => {
                console.debug('[Deepthix][TopTabs] mode ->', m);
                onChangeMode(m);
              }}
              style={{
                padding: touch ? '6px 10px' : '6px 12px',
                minHeight: touch ? 44 : undefined,
                minWidth: touch ? 44 : undefined,
                background: active ? 'var(--color-bg)' : 'transparent',
                color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
                border: 'none',
                borderBottom: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
                cursor: 'pointer',
                fontFamily: 'var(--font-pixel)',
                fontSize: '0.8125rem',
                letterSpacing: '0.01em',
                fontWeight: active ? 600 : 'normal',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                flexShrink: 0,
                whiteSpace: 'nowrap',
                borderRadius: 'var(--surface-radius, 0px) var(--surface-radius, 0px) 0 0',
                transition: 'color 120ms ease, border-color 120ms ease, background 120ms ease',
              }}
              onMouseEnter={(e) => {
                if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text)';
              }}
              onMouseLeave={(e) => {
                if (!active)
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)';
              }}
              title={`Switch to ${meta.label}`}
              aria-label={meta.label}
            >
              <Icon size="1.15em" strokeWidth={1.75} aria-hidden />
              {!touch && <span>{meta.label}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
