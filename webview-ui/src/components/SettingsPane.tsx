// Full-area pane shown when `mode === 'settings'`. Mounted by App.tsx, fed
// by `useGlobalConfig`. Three controls in the Terminal section:
//   • font size  (− value +) — clamps to TERMINAL_FONT_SIZE_MIN/MAX
//   • font family (<select>) — preset list from constants
//   • line height (− value +) — quantized to TERMINAL_LINE_HEIGHT_STEP
// Plus a small About section.
//
// Mutations apply LIVE to every open terminal because every TerminalTab is
// reading the same `useGlobalConfig` snapshot.

import { useCallback } from 'react';

import {
  TERMINAL_FONT_FAMILY_PRESETS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_LINE_HEIGHT_STEP,
} from '../constants';
import type { UseGlobalConfigResult } from '../hooks/useGlobalConfig';
import { THEMES } from '../themes';

interface Props {
  globalConfig: UseGlobalConfigResult;
}

/** Round a line-height value to step precision (avoids 1.0500000001 jitter). */
function quantizeLineHeight(n: number): number {
  const stepped = Math.round(n / TERMINAL_LINE_HEIGHT_STEP) * TERMINAL_LINE_HEIGHT_STEP;
  return Math.min(TERMINAL_LINE_HEIGHT_MAX, Math.max(TERMINAL_LINE_HEIGHT_MIN, stepped));
}

export function SettingsPane({ globalConfig }: Props): React.JSX.Element {
  const { config, update } = globalConfig;

  const bumpFont = useCallback(
    (delta: number) => {
      const next = Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, config.terminalFontSize + delta),
      );
      if (next !== config.terminalFontSize) update({ terminalFontSize: next });
    },
    [config.terminalFontSize, update],
  );

  const bumpLineHeight = useCallback(
    (delta: number) => {
      const next = quantizeLineHeight(config.terminalLineHeight + delta);
      if (Math.abs(next - config.terminalLineHeight) > 1e-6) {
        update({ terminalLineHeight: next });
      }
    },
    [config.terminalLineHeight, update],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: 'var(--color-bg)',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        overflow: 'auto',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      {/* TERMINAL section */}
      <Section title="TERMINAL" subtitle="Applies to ALL claude sessions across every project.">
        <Row label="Font size">
          <BumpControl
            value={String(config.terminalFontSize)}
            onMinus={() => bumpFont(-1)}
            onPlus={() => bumpFont(+1)}
            ariaLabel="font size"
          />
          <span style={{ opacity: 0.5, fontSize: '12px', marginLeft: '8px' }}>
            ({TERMINAL_FONT_SIZE_MIN}–{TERMINAL_FONT_SIZE_MAX} px)
          </span>
        </Row>

        <Row label="Font family">
          <select
            value={config.terminalFontFamily}
            onChange={(e) => update({ terminalFontFamily: e.target.value })}
            style={{
              background: 'var(--color-bg-dark)',
              color: 'inherit',
              border: '2px solid var(--color-border)',
              padding: '4px 8px',
              fontFamily: 'var(--font-pixel)',
              fontSize: '13px',
              minWidth: '240px',
              cursor: 'pointer',
            }}
            title="Terminal font family"
          >
            {/* If the persisted value isn't in the preset list (custom), surface
                it as an extra option so the dropdown never displays blank. */}
            {!TERMINAL_FONT_FAMILY_PRESETS.some((p) => p.value === config.terminalFontFamily) && (
              <option value={config.terminalFontFamily}>(custom)</option>
            )}
            {TERMINAL_FONT_FAMILY_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Line height">
          <BumpControl
            value={config.terminalLineHeight.toFixed(2)}
            onMinus={() => bumpLineHeight(-TERMINAL_LINE_HEIGHT_STEP)}
            onPlus={() => bumpLineHeight(+TERMINAL_LINE_HEIGHT_STEP)}
            ariaLabel="line height"
          />
          <span style={{ opacity: 0.5, fontSize: '12px', marginLeft: '8px' }}>
            ({TERMINAL_LINE_HEIGHT_MIN.toFixed(1)}–{TERMINAL_LINE_HEIGHT_MAX.toFixed(1)})
          </span>
        </Row>

        <div
          style={{
            marginTop: '8px',
            padding: '8px 10px',
            background: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
            fontSize: '12px',
            opacity: 0.75,
            lineHeight: 1.5,
          }}
        >
          Tip: <code style={{ fontFamily: 'var(--font-pixel)' }}>Cmd =</code> /{' '}
          <code style={{ fontFamily: 'var(--font-pixel)' }}>Cmd -</code> /{' '}
          <code style={{ fontFamily: 'var(--font-pixel)' }}>Cmd 0</code> from inside any
          terminal also adjusts the global font size.
        </div>
      </Section>

      {/* THEME section */}
      <Section title="THEME" subtitle="Pre-built color packs that look good together. Live preview.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
          {THEMES.map((t) => {
            const active = t.id === config.themeId;
            return (
              <button
                key={t.id}
                onClick={() => update({ themeId: t.id })}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '10px',
                  background: t.colors['color-bg-dark'],
                  border: `2px solid ${active ? t.colors['color-accent'] : t.colors['color-border']}`,
                  boxShadow: active ? `4px 4px 0 ${t.colors['color-accent']}` : `2px 2px 0 ${t.colors['color-border']}`,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-pixel)',
                  color: t.colors['color-text'],
                  textAlign: 'left',
                  fontSize: '13px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <span>{t.name}</span>
                  {active && <span style={{ fontSize: '11px', opacity: 0.7 }}>●</span>}
                </div>
                <div style={{ display: 'flex', gap: '4px', height: '14px' }}>
                  {['color-bg', 'color-accent', 'color-status-success', 'color-danger', 'color-warning'].map((k) => (
                    <span key={k} style={{ flex: 1, background: t.colors[k], border: `1px solid ${t.colors['color-border']}` }} />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      {/* ABOUT section */}
      <Section title="ABOUT" subtitle="">
        <div style={{ fontSize: '13px', lineHeight: 1.6, opacity: 0.85 }}>
          <div>
            <strong>Deepthix Agent</strong>
            <span style={{ opacity: 0.6, marginLeft: '6px' }}>v0.1.0</span>
          </div>
          <div style={{ marginTop: 6 }}>
            Forked from{' '}
            <a
              href="https://github.com/pablodelucca/pixel-agents"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-accent-bright)' }}
            >
              pixel-agents
            </a>{' '}
            (MIT, by @pablodelucca).
          </div>
        </div>
      </Section>

      <div
        style={{
          marginTop: 'auto',
          padding: '6px 0 0',
          fontSize: '12px',
          opacity: 0.55,
        }}
      >
        Per-session terminal settings have been removed; these apply to ALL sessions.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Layout primitives — kept in-file because they're trivial and
// SettingsPane-specific (no other pane uses this exact card style yet).
// ─────────────────────────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

function Section({ title, subtitle, children }: SectionProps): React.JSX.Element {
  return (
    <div
      style={{
        background: 'var(--color-bg)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '12px',
          borderBottom: '2px solid var(--color-border)',
          paddingBottom: '8px',
          marginBottom: '4px',
        }}
      >
        <span style={{ fontSize: '14px', letterSpacing: '0.08em' }}>{title}</span>
        {subtitle && (
          <span style={{ fontSize: '12px', opacity: 0.6 }}>{subtitle}</span>
        )}
      </div>
      {children}
    </div>
  );
}

interface RowProps {
  label: string;
  children: React.ReactNode;
}

function Row({ label, children }: RowProps): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span style={{ fontSize: '13px', opacity: 0.75, minWidth: '120px' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>{children}</div>
    </div>
  );
}

interface BumpControlProps {
  value: string;
  onMinus: () => void;
  onPlus: () => void;
  ariaLabel: string;
}

function BumpControl({ value, onMinus, onPlus, ariaLabel }: BumpControlProps): React.JSX.Element {
  const buttonStyle: React.CSSProperties = {
    width: '28px',
    minWidth: '28px',
    height: '28px',
    padding: 0,
    background: 'transparent',
    color: 'inherit',
    border: '2px solid var(--color-border)',
    cursor: 'pointer',
    fontFamily: 'var(--font-pixel)',
    fontSize: '14px',
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  const valueStyle: React.CSSProperties = {
    minWidth: '46px',
    textAlign: 'center',
    fontFamily: 'var(--font-pixel)',
    fontSize: '13px',
    padding: '0 8px',
  };
  return (
    <>
      <button
        type="button"
        onClick={onMinus}
        style={buttonStyle}
        aria-label={`Decrease ${ariaLabel}`}
        title={`Decrease ${ariaLabel}`}
      >
        −
      </button>
      <span style={valueStyle} aria-label={`Current ${ariaLabel}`}>
        {value}
      </span>
      <button
        type="button"
        onClick={onPlus}
        style={buttonStyle}
        aria-label={`Increase ${ariaLabel}`}
        title={`Increase ${ariaLabel}`}
      >
        +
      </button>
    </>
  );
}
