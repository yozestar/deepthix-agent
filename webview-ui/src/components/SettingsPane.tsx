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

import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { useCallback, useEffect, useState } from 'react';

import {
  TERMINAL_FONT_FAMILY_PRESETS,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_LINE_HEIGHT_STEP,
} from '../constants';
import type { BoxStyleId, UiFontId, UseGlobalConfigResult } from '../hooks/useGlobalConfig';
import {
  BOX_STYLE_IDS,
  MAX_ACTIVE_SESSIONS_DEFAULT,
  MAX_ACTIVE_SESSIONS_MAX,
  MAX_ACTIVE_SESSIONS_MIN,
  MAX_MESSAGES_PER_SESSION_DEFAULT,
  MAX_MESSAGES_PER_SESSION_MAX,
  MAX_MESSAGES_PER_SESSION_MIN,
  UI_TEXT_SCALE_MAX,
  UI_TEXT_SCALE_MIN,
  UI_TEXT_SCALE_STEP,
} from '../hooks/useGlobalConfig';
import { resolveTheme, SYSTEM_THEME_ID, THEMES } from '../themes';

interface BoxStyleMeta {
  id: BoxStyleId;
  label: string;
  blurb: string;
}
const BOX_STYLE_META: BoxStyleMeta[] = [
  { id: 'modern', label: 'Modern', blurb: 'Rounded corners, hairline borders, soft shadows. Calm for long reading.' },
  { id: 'pixel', label: 'Pixel', blurb: 'Hard 2px shadow, square corners. The original look.' },
  { id: 'glass', label: 'Glass', blurb: 'Frosted backdrop blur + translucent surface.' },
  { id: 'flat', label: 'Flat', blurb: 'Hairline border, no shadow.' },
  { id: 'soft', label: 'Soft', blurb: 'Rounded corners + soft drop shadow.' },
  { id: 'neon', label: 'Neon', blurb: 'Accent-glow border on dark body.' },
];

interface UiFontMeta {
  id: UiFontId;
  label: string;
  previewFamily: string;
  blurb: string;
}
const UI_FONTS: UiFontMeta[] = [
  {
    id: 'pixel',
    label: 'Pixel',
    previewFamily: "'FS Pixel Sans', sans-serif",
    blurb: 'Le look original, charme pixel-art.',
  },
  {
    id: 'inter',
    label: 'Inter',
    previewFamily: "'Inter', sans-serif",
    blurb: 'Lisible, anti-aliasée — recommandée pour les longues sessions de lecture.',
  },
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
          <span style={{ opacity: 0.5, fontSize: '0.75rem', marginLeft: '8px' }}>
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
                  <span style={{ fontSize: '0.6875rem', opacity: 0.85 }}>{p.label}</span>
                  {/* Preview rendered with the actual stack so the user sees
                      what they're picking before committing. */}
                  <span
                    style={{
                      fontFamily: p.value,
                      fontSize: '0.875rem',
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
                  fontSize: '0.6875rem',
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
          <span style={{ opacity: 0.5, fontSize: '0.75rem', marginLeft: '8px' }}>
            ({TERMINAL_LINE_HEIGHT_MIN.toFixed(1)}–{TERMINAL_LINE_HEIGHT_MAX.toFixed(1)})
          </span>
        </Row>

        <div
          style={{
            marginTop: '8px',
            padding: '8px 10px',
            background: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
            fontSize: '0.75rem',
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
          <SystemThemeCard
            active={config.themeId === SYSTEM_THEME_ID}
            onPick={() => update({ themeId: SYSTEM_THEME_ID })}
          />
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
                  fontSize: '0.8125rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <span>{t.name}</span>
                  {active && <span style={{ fontSize: '0.6875rem', opacity: 0.7 }}>●</span>}
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

      {/* UI FONT section — drives --font-pixel globally. Separate from
          the terminal font (which lives in the TERMINAL section above
          and only affects xterm). */}
      <Section
        title="UI FONT"
        subtitle="Police de l'interface — bascule pour les longues sessions de lecture."
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '10px',
          }}
        >
          {UI_FONTS.map((f) => {
            const active = f.id === config.uiFont;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => update({ uiFont: f.id })}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: '12px',
                  background: 'var(--color-bg-dark)',
                  border: `2px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  boxShadow: active
                    ? '4px 4px 0 var(--color-accent)'
                    : 'var(--shadow-pixel)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-pixel)',
                  color: 'var(--color-text)',
                  textAlign: 'left',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.8125rem',
                  }}
                >
                  <span>{f.label}</span>
                  {active && <span style={{ fontSize: '0.6875rem', opacity: 0.7 }}>●</span>}
                </div>
                <span
                  style={{
                    fontFamily: f.previewFamily,
                    fontSize: '1rem',
                    letterSpacing: 0,
                    lineHeight: 1.4,
                  }}
                >
                  The quick brown fox 0123
                </span>
                <span style={{ fontSize: '0.625rem', opacity: 0.6, lineHeight: 1.4 }}>
                  {f.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* UI TEXT SCALE — scales every rem/em-based text without touching
          fixed pixel widths so the layout stays put (xterm unaffected). */}
      <Section
        title="TEXT SIZE"
        subtitle="Agrandit le texte de l'interface (chat, sidebar, settings) sans casser la mise en page. xterm garde sa propre taille."
      >
        <Row label="Échelle texte">
          <BumpControl
            value={`${Math.round(config.uiTextScale * 100)} %`}
            onMinus={() =>
              update({
                uiTextScale: Math.max(
                  UI_TEXT_SCALE_MIN,
                  Number((config.uiTextScale - UI_TEXT_SCALE_STEP).toFixed(2)),
                ),
              })
            }
            onPlus={() =>
              update({
                uiTextScale: Math.min(
                  UI_TEXT_SCALE_MAX,
                  Number((config.uiTextScale + UI_TEXT_SCALE_STEP).toFixed(2)),
                ),
              })
            }
            ariaLabel="UI text scale"
          />
        </Row>
        <div style={{ fontSize: '0.75rem', opacity: 0.65 }}>
          Raccourcis : Ctrl + / Ctrl − / Ctrl 0 (réinitialiser), partout sauf dans un terminal.
        </div>
        <ReadingPreview />
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
                    fontSize: '0.8125rem',
                  }}
                >
                  <span>{s.label}</span>
                  {active && <span style={{ fontSize: '0.6875rem', opacity: 0.7 }}>●</span>}
                </div>
                <BoxStylePreview id={s.id} />
                <span style={{ fontSize: '0.625rem', opacity: 0.6, lineHeight: 1.4 }}>
                  {s.blurb}
                </span>
              </button>
            );
          })}
        </div>
        {!(BOX_STYLE_IDS as readonly string[]).includes(config.boxStyle) && (
          <div style={{ fontSize: '0.6875rem', opacity: 0.6 }}>
            (custom — {config.boxStyle})
          </div>
        )}
      </Section>

      {/* SESSIONS section — caps that protect the host from runaway
          memory use. Tweakable live; the backend re-reads on every
          chat_spawn and the chat-pane caps in real time. */}
      <SessionsSection
        maxActiveSessions={config.maxActiveSessions}
        maxMessagesPerSession={config.maxMessagesPerSession}
        onChange={update}
      />

      {/* UPDATES section — shows current version + update status, with a
          manual Check button. The UpdaterBanner at the top of the window
          covers the silent on-launch check; this section is the explicit
          place to look ("où je vois que je dois faire un update?"). */}
      <UpdatesSection />

      {/* ABOUT section */}
      <AboutSection />

      <div
        style={{
          marginTop: 'auto',
          padding: '6px 0 0',
          fontSize: '0.75rem',
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
        <span style={{ fontSize: '0.875rem', letterSpacing: '0.08em' }}>{title}</span>
        {subtitle && (
          <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>{subtitle}</span>
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
          fontSize: '0.8125rem',
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
    fontSize: '0.6875rem',
    fontFamily: 'var(--font-pixel)',
    color: 'var(--color-text)',
    display: 'flex',
    alignItems: 'center',
  };
  let style: React.CSSProperties;
  switch (id) {
    case 'modern':
      style = {
        ...base,
        background: 'var(--color-bg-dark)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        boxShadow: '0 1px 2px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.12)',
      };
      break;
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

/** Theme card for the OS-following pseudo-theme: split swatch showing
 *  the light and dark palettes it switches between. */
function SystemThemeCard({ active, onPick }: { active: boolean; onPick: () => void }): React.JSX.Element {
  const dark = resolveTheme(SYSTEM_THEME_ID, true);
  const light = resolveTheme(SYSTEM_THEME_ID, false);
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px',
        background: light.colors['color-bg-dark'],
        border: `2px solid ${active ? dark.colors['color-accent'] : dark.colors['color-border']}`,
        boxShadow: active ? `4px 4px 0 ${dark.colors['color-accent']}` : `2px 2px 0 ${dark.colors['color-border']}`,
        cursor: 'pointer',
        fontFamily: 'var(--font-pixel)',
        color: light.colors['color-text'],
        textAlign: 'left',
        fontSize: '0.8125rem',
      }}
      title="Clair le jour, sombre le soir — suit le réglage clair/sombre de Windows"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span>Suivre Windows</span>
        {active && <span style={{ fontSize: '0.6875rem', opacity: 0.7 }}>●</span>}
      </div>
      <div style={{ display: 'flex', gap: '4px', height: '14px' }}>
        {[light, dark].flatMap((t) =>
          ['color-bg', 'color-accent'].map((k) => (
            <span
              key={`${t.id}-${k}`}
              style={{ flex: 1, background: t.colors[k], border: `1px solid ${t.colors['color-border']}` }}
            />
          )),
        )}
      </div>
    </button>
  );
}

/** Live sample of a chat exchange rendered with the CURRENT theme, font,
 *  text size and box style — so the user sees the reading comfort
 *  before leaving Settings. */
function ReadingPreview(): React.JSX.Element {
  return (
    <div
      style={{
        marginTop: 8,
        padding: 12,
        background: 'var(--color-bg-session)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--surface-radius, 0px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: '0.6875rem', opacity: 0.6 }}>Aperçu</div>
      <div
        style={{
          alignSelf: 'flex-end',
          maxWidth: '80%',
          padding: '8px 12px',
          background: 'var(--color-accent)',
          color: 'var(--color-bg-dark)',
          borderRadius: 'var(--surface-radius, 0px)',
          fontSize: '0.875rem',
        }}
      >
        Peux-tu vérifier les factures en attente ?
      </div>
      <div
        style={{
          alignSelf: 'flex-start',
          maxWidth: '80%',
          padding: '8px 12px',
          background: 'var(--color-bg-dark)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--surface-radius, 0px)',
          fontSize: '0.875rem',
          lineHeight: 1.6,
        }}
      >
        J&apos;ai trouvé <strong>12 factures</strong> en brouillon, pour un total de{' '}
        <code>18 240,00 €</code> HT.
      </div>
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
    fontSize: '0.875rem',
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  const valueStyle: React.CSSProperties = {
    minWidth: '46px',
    textAlign: 'center',
    fontFamily: 'var(--font-pixel)',
    fontSize: '0.8125rem',
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

// ─── UPDATES + ABOUT sections ────────────────────────────────────────────
// Pulled out of the main component so they can do their own state +
// effects without forcing the whole pane to re-render.

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up_to_date'; checkedAt: number }
  | { kind: 'available'; update: Update }
  | { kind: 'not_configured' } // signing keys not set on the repo → empty platforms
  | { kind: 'error'; message: string };

/** The plugin-updater error fired when latest.json's `platforms` object
 *  contains nothing for the current OS+arch. We hit this on every release
 *  shipped without `TAURI_SIGNING_PRIVATE_KEY` configured on the repo —
 *  the aggregator emits `platforms: {}` and the updater (correctly)
 *  refuses to proceed. Surface this as "not configured" rather than a
 *  scary red ERROR pill — the app itself is fine, only auto-update is
 *  off until the maintainer sets up signing. */
function isMissingPlatformsError(msg: string): boolean {
  return /none of the fallback platforms/i.test(msg) || /platforms.*were found/i.test(msg);
}

function UpdatesSection(): React.JSX.Element {
  const [version, setVersion] = useState<string>('…');
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch((e) => console.warn('[Deepthix][SettingsPane] getVersion failed', e));
  }, []);

  // Run a check on mount so the user always sees a fresh status when
  // they land on Settings — not the stale state from the last time.
  useEffect(() => {
    void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCheck = useCallback(async (): Promise<void> => {
    setStatus({ kind: 'checking' });
    try {
      const upd = await check();
      if (upd) setStatus({ kind: 'available', update: upd });
      else setStatus({ kind: 'up_to_date', checkedAt: Date.now() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[Deepthix][SettingsPane] update check failed', e);
      if (isMissingPlatformsError(msg)) {
        setStatus({ kind: 'not_configured' });
      } else {
        setStatus({ kind: 'error', message: msg });
      }
    }
  }, []);

  // Color-coded status pill so you can see at a glance: green = up to
  // date, orange = update available, gray = checking, red = error.
  let statusPill: React.JSX.Element;
  switch (status.kind) {
    case 'idle':
      statusPill = <Pill bg="var(--color-border)" text="—" />;
      break;
    case 'checking':
      statusPill = <Pill bg="var(--color-border)" text="checking…" />;
      break;
    case 'up_to_date':
      statusPill = <Pill bg="#16a34a" text="UP TO DATE" />;
      break;
    case 'not_configured':
      statusPill = <Pill bg="#6b7280" text="AUTO-UPDATE NOT SET UP" />;
      break;
    case 'available':
      statusPill = <Pill bg="#f59e0b" text={`UPDATE → v${status.update.version}`} />;
      break;
    case 'error':
      statusPill = <Pill bg="#ef4444" text="ERROR" />;
      break;
  }

  return (
    <Section
      title="UPDATES"
      subtitle="Auto-checked on every launch. The orange banner at the top of the window appears when an update is available."
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.8125rem' }}>
          Installed: <strong>v{version}</strong>
        </span>
        {statusPill}
      </div>
      {status.kind === 'available' && (
        <div style={{ fontSize: '0.75rem', opacity: 0.85, lineHeight: 1.5 }}>
          A newer version is available. Open the orange banner at the top of the window and click
          <strong> Install + restart</strong>. (Or run the manual install via the project README.)
        </div>
      )}
      {status.kind === 'error' && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-danger)', lineHeight: 1.5 }}>
          {status.message}
        </div>
      )}
      {status.kind === 'not_configured' && (
        <div style={{ fontSize: '0.75rem', opacity: 0.7, lineHeight: 1.5 }}>
          The repo's release pipeline ships unsigned artifacts (no `TAURI_SIGNING_PRIVATE_KEY` secret yet), so the in-app updater can't verify downloads. The app itself is fine — manual install from the GitHub release page works as before.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            void runCheck();
            // Also poke the banner so it re-evaluates.
            window.dispatchEvent(new CustomEvent('deepthix:updater:check'));
          }}
          disabled={status.kind === 'checking'}
          style={{
            padding: '6px 12px',
            background: 'transparent',
            color: 'inherit',
            border: '2px solid var(--color-border)',
            fontFamily: 'var(--font-pixel)',
            fontSize: '0.75rem',
            cursor: status.kind === 'checking' ? 'wait' : 'pointer',
          }}
        >
          ⬆ Check now
        </button>
      </div>
    </Section>
  );
}

function AboutSection(): React.JSX.Element {
  const [version, setVersion] = useState<string>('…');
  useEffect(() => {
    void getVersion().then(setVersion).catch(() => setVersion('?'));
  }, []);
  return (
    <Section title="ABOUT" subtitle="">
      <div style={{ fontSize: '0.8125rem', lineHeight: 1.6, opacity: 0.85 }}>
        <div>
          <strong>Deepthix Agent</strong>
          <span style={{ opacity: 0.6, marginLeft: 6 }}>v{version}</span>
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
  );
}

function SessionsSection({
  maxActiveSessions,
  maxMessagesPerSession,
  onChange,
}: {
  maxActiveSessions: number;
  maxMessagesPerSession: number;
  onChange: (partial: { maxActiveSessions?: number; maxMessagesPerSession?: number }) => void;
}): React.JSX.Element {
  return (
    <Section
      title="SESSIONS"
      subtitle="Protect the host from runaway memory. Each claude session holds 200-250 MB; long conversations bloat the React tree."
    >
      <NumberRow
        label="Max active sessions"
        hint={`Hard cap on concurrent chat sessions Deepthix will spawn. ${MAX_ACTIVE_SESSIONS_MIN}-${MAX_ACTIVE_SESSIONS_MAX}, default ${MAX_ACTIVE_SESSIONS_DEFAULT}.`}
        value={maxActiveSessions}
        min={MAX_ACTIVE_SESSIONS_MIN}
        max={MAX_ACTIVE_SESSIONS_MAX}
        step={1}
        onChange={(n) => onChange({ maxActiveSessions: n })}
      />
      <NumberRow
        label="Max messages per session (live cap)"
        hint={`Trailing messages kept in memory per session. Older drop in real time so typing stays fluid. ${MAX_MESSAGES_PER_SESSION_MIN}-${MAX_MESSAGES_PER_SESSION_MAX}, default ${MAX_MESSAGES_PER_SESSION_DEFAULT}.`}
        value={maxMessagesPerSession}
        min={MAX_MESSAGES_PER_SESSION_MIN}
        max={MAX_MESSAGES_PER_SESSION_MAX}
        step={50}
        onChange={(n) => onChange({ maxMessagesPerSession: n })}
      />
    </Section>
  );
}

function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}): React.JSX.Element {
  const clamp = (n: number): number => Math.max(min, Math.min(max, Math.round(n)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.8125rem' }}>{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" onClick={() => onChange(clamp(value - step))} style={bumpStyle}>
            −
          </button>
          <span style={{ fontSize: '0.8125rem', minWidth: 36, textAlign: 'center' }}>{value}</span>
          <button type="button" onClick={() => onChange(clamp(value + step))} style={bumpStyle}>
            +
          </button>
        </div>
      </div>
      <span style={{ fontSize: '0.6875rem', opacity: 0.6, lineHeight: 1.5 }}>{hint}</span>
    </div>
  );
}

const bumpStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  background: 'transparent',
  color: 'inherit',
  border: '2px solid var(--color-border)',
  fontFamily: 'var(--font-pixel)',
  fontSize: '0.875rem',
  cursor: 'pointer',
};

function Pill({ bg, text }: { bg: string; text: string }): React.JSX.Element {
  return (
    <span
      style={{
        background: bg,
        color: '#fff',
        padding: '3px 8px',
        fontSize: '0.625rem',
        fontWeight: 'bold',
        letterSpacing: '0.05em',
        fontFamily: 'var(--font-pixel)',
        border: '1px solid var(--color-border)',
      }}
    >
      {text}
    </span>
  );
}

