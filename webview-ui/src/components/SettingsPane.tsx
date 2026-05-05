/* eslint-disable deepthix/no-inline-colors, deepthix/pixel-shadow */
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
import type { BoxStyleId, UseGlobalConfigResult } from '../hooks/useGlobalConfig';
import { BOX_STYLE_IDS } from '../hooks/useGlobalConfig';
import { THEMES } from '../themes';

interface BoxStyleMeta {
  id: BoxStyleId;
  label: string;
  blurb: string;
}
const BOX_STYLE_META: BoxStyleMeta[] = [
  { id: 'pixel', label: 'Pixel', blurb: 'Hard 2px shadow, square corners. The original look.' },
  { id: 'glass', label: 'Glass', blurb: 'Frosted backdrop blur + translucent surface.' },
  { id: 'flat', label: 'Flat', blurb: 'Hairline border, no shadow.' },
  { id: 'soft', label: 'Soft', blurb: 'Rounded corners + soft drop shadow.' },
  { id: 'neon', label: 'Neon', blurb: 'Accent-glow border on dark body.' },
];

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

        <Row label="Font family" align="start">
          {/* Grille de presets avec preview live de chaque font. Picking ne
              fait pas de round-trip aller-retour — on persiste tout de suite
              et `useGlobalConfig` propage la nouvelle valeur jusqu'aux
              terminaux. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '6px',
              maxWidth: '720px',
            }}
          >
            {TERMINAL_FONT_FAMILY_PRESETS.map((p) => {
              const selected = p.value === config.terminalFontFamily;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => update({ terminalFontFamily: p.value })}
                  title={p.value}
                  style={{
                    textAlign: 'left',
                    padding: '6px 8px',
                    background: selected ? 'var(--color-accent)' : 'var(--color-bg-dark)',
                    color: selected ? 'var(--color-bg-dark)' : 'inherit',
                    border: '2px solid var(--color-border)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                    fontFamily: 'var(--font-pixel)',
                  }}
                >
                  <span style={{ fontSize: '11px', opacity: 0.85 }}>{p.label}</span>
                  {/* Preview rendered with the actual stack so the user sees
                      what they're picking before committing. */}
                  <span
                    style={{
                      fontFamily: p.value,
                      fontSize: '14px',
                      letterSpacing: 0,
                    }}
                  >
                    The quick brown fox 0123
                  </span>
                </button>
              );
            })}
            {/* Custom value (typed via the legacy path or persisted from an
                older config) gets a visible "(custom)" entry. */}
            {!TERMINAL_FONT_FAMILY_PRESETS.some((p) => p.value === config.terminalFontFamily) && (
              <div
                style={{
                  padding: '6px 8px',
                  background: 'var(--color-accent)',
                  color: 'var(--color-bg-dark)',
                  border: '2px solid var(--color-border)',
                  fontFamily: 'var(--font-pixel)',
                  fontSize: '11px',
                }}
              >
                (custom) — {config.terminalFontFamily}
              </div>
            )}
          </div>
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

      {/* BOX STYLE section — chrome of every bubble / card / panel. */}
      <Section
        title="BOX STYLE"
        subtitle="Chrome of every bubble, card and panel. Live preview."
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '10px',
          }}
        >
          {BOX_STYLE_META.map((s) => {
            const active = s.id === config.boxStyle;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => update({ boxStyle: s.id })}
                title={s.blurb}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: '10px',
                  background: 'var(--color-bg-dark)',
                  border: `2px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  boxShadow: active ? '4px 4px 0 var(--color-accent)' : 'var(--shadow-pixel)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-pixel)',
                  textAlign: 'left',
                  color: 'var(--color-text)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '13px',
                  }}
                >
                  <span>{s.label}</span>
                  {active && <span style={{ fontSize: '11px', opacity: 0.7 }}>●</span>}
                </div>
                <BoxStylePreview id={s.id} />
                <span style={{ fontSize: '10px', opacity: 0.6, lineHeight: 1.4 }}>
                  {s.blurb}
                </span>
              </button>
            );
          })}
        </div>
        {!(BOX_STYLE_IDS as readonly string[]).includes(config.boxStyle) && (
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            (custom — {config.boxStyle})
          </div>
        )}
      </Section>

      {/* UPDATES section — manual trigger; the auto-check on launch
          (UpdaterBanner) covers the silent path. */}
      <Section
        title="UPDATES"
        subtitle="Auto-check runs on every launch. Manual check is also fine."
      >
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('deepthix:updater:check'))}
          style={{
            alignSelf: 'flex-start',
            padding: '6px 12px',
            background: 'transparent',
            color: 'inherit',
            border: '2px solid var(--color-border)',
            fontFamily: 'var(--font-pixel)',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          ⬆ Check for updates
        </button>
      </Section>

      {/* ABOUT section */}
      <Section title="ABOUT" subtitle="">
        <div style={{ fontSize: '13px', lineHeight: 1.6, opacity: 0.85 }}>
          <div>
            <strong>Deepthix Agent</strong>
            <span style={{ opacity: 0.6, marginLeft: '6px' }}>v0.1.0</span>
          </div>
          <div style={{ marginTop: 6 }}>
            Open source —{' '}
            <a
              href="https://github.com/deepthix/deepthix-agent"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-accent-bright)' }}
            >
              github.com/deepthix/deepthix-agent
            </a>
            . MIT licensed.
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
  /** "start" lets the row contain a tall multi-line block (font picker grid). */
  align?: 'center' | 'start';
}

function Row({ label, children, align = 'center' }: RowProps): React.JSX.Element {
  const alignItems = align === 'start' ? 'flex-start' : 'center';
  return (
    <div style={{ display: 'flex', alignItems, gap: '12px' }}>
      <span
        style={{
          fontSize: '13px',
          opacity: 0.75,
          minWidth: '120px',
          paddingTop: align === 'start' ? '4px' : 0,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: align === 'start' ? 'flex-start' : 'center',
          gap: '4px',
          flex: align === 'start' ? 1 : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Inline preview of a single box-style. Uses static styles that mirror
 *  the CSS rules in index.css so the user sees what they're picking
 *  before committing. */
function BoxStylePreview({ id }: { id: BoxStyleId }): React.JSX.Element {
  const base: React.CSSProperties = {
    height: 36,
    padding: '6px 8px',
    fontSize: 11,
    fontFamily: 'var(--font-pixel)',
    color: 'var(--color-text)',
    display: 'flex',
    alignItems: 'center',
  };
  let style: React.CSSProperties;
  switch (id) {
    case 'pixel':
      style = {
        ...base,
        background: 'var(--color-bg-dark)',
        border: '2px solid var(--color-border)',
        boxShadow: 'var(--shadow-pixel)',
      };
      break;
    case 'glass':
      style = {
        ...base,
        background: 'rgba(24, 24, 40, 0.55)',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: 12,
        boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
      };
      break;
    case 'flat':
      style = {
        ...base,
        background: 'var(--color-bg-dark)',
        border: '1px solid var(--color-border)',
        boxShadow: 'none',
      };
      break;
    case 'soft':
      style = {
        ...base,
        background: 'var(--color-bg-dark)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      };
      break;
    case 'neon':
      style = {
        ...base,
        background: 'var(--color-bg-dark)',
        border: '1px solid var(--color-accent)',
        borderRadius: 6,
        boxShadow: '0 0 0 1px var(--color-accent), 0 0 12px rgba(255, 60, 140, 0.45)',
      };
      break;
  }
  return <div style={style}>preview</div>;
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
