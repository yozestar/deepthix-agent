import { useCallback, useEffect, useRef, useState } from 'react';

import type { TerminalEntry } from '../hooks/useTerminals';

const SPECIES = [
  { emoji: '🐶', name: 'Pup' },
  { emoji: '🐱', name: 'Kit' },
  { emoji: '🐰', name: 'Bun' },
  { emoji: '🦊', name: 'Fox' },
  { emoji: '🐻', name: 'Bear' },
  { emoji: '🐼', name: 'Panda' },
  { emoji: '🐨', name: 'Koala' },
  { emoji: '🐯', name: 'Tiger' },
  { emoji: '🦁', name: 'Lion' },
  { emoji: '🐸', name: 'Frog' },
  { emoji: '🐵', name: 'Mono' },
  { emoji: '🦝', name: 'Coon' },
  { emoji: '🐹', name: 'Hams' },
  { emoji: '🦔', name: 'Hog' },
  { emoji: '🐧', name: 'Pen' },
] as const;

type AgentState = 'idle' | 'working' | 'waiting';

interface Animal {
  id: number;
  termId: string;
  label: string;
  emoji: string;
  hue: number;       // CSS hue rotation degrees, 0–360
  x: number;         // 0..1 normalized
  y: number;         // 0..1 normalized
  vx: number;        // velocity per frame, normalized
  vy: number;
  state: AgentState;
  toolHint: string;  // displayed bubble when working
  bornAt: number;
  lastWaveAt: number;
}

/** djb2 — fast deterministic string hash. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Same projectId → same emoji (1:1 within the SPECIES list). */
function projectEmoji(projectId: string): string {
  return SPECIES[hashString(projectId) % SPECIES.length].emoji;
}

/**
 * Same projectId → same base hue. Different agents within the project get
 * a small offset so they're distinguishable but visually a "family".
 */
function projectHue(projectId: string, agentIndex: number): number {
  const base = hashString(projectId) % 360;
  return (base + agentIndex * 35) % 360;
}

interface Props {
  /** Active project name shown as the header. */
  projectName: string | null;
  /** All claude terminals scoped to the active project. */
  terminals: TerminalEntry[];
}

/**
 * Simple tamagotchi-style visualization. Each claude agent in the active
 * project becomes a randomly-coloured animal that wanders around the
 * canvas. They wave at each other when nearby. While the agent's claude
 * session is using a tool, the animal bounces (working state). After a
 * `turn_duration` system event it returns to idle.
 */
export function TamagotchiView({ projectName, terminals }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [animals, setAnimals] = useState<Map<number, Animal>>(new Map());

  // ── Sync animals with the current agent list ─────────────────────────
  useEffect(() => {
    setAnimals((prev) => {
      const next = new Map(prev);
      // Each project gets a deterministic emoji + base hue so the same
      // project always shows the same animal across restarts. Within a
      // project, agents share the emoji but get a small hue offset so
      // multiple agents in the same project remain distinguishable.
      const claudeTerms = terminals.filter((t) => t.kind === 'claude');
      claudeTerms.forEach((t, indexWithinProject) => {
        if (next.has(t.agentId)) return;
        next.set(t.agentId, {
          id: t.agentId,
          termId: t.id,
          label: t.label,
          emoji: projectEmoji(t.projectId),
          hue: projectHue(t.projectId, indexWithinProject),
          x: 0.1 + Math.random() * 0.8,
          y: 0.2 + Math.random() * 0.6,
          vx: (Math.random() - 0.5) * 0.0015,
          vy: (Math.random() - 0.5) * 0.0015,
          state: 'idle',
          toolHint: '',
          bornAt: Date.now(),
          lastWaveAt: 0,
        });
      });
      const presentIds = new Set(terminals.map((t) => t.agentId));
      for (const id of next.keys()) {
        if (!presentIds.has(id)) next.delete(id);
      }
      return next;
    });
  }, [terminals]);

  // ── Subscribe to agent activity events ───────────────────────────────
  useEffect(() => {
    function handler(ev: MessageEvent): void {
      const data = ev.data as { type?: string; agentId?: number; toolName?: string; id?: number };
      if (!data || typeof data !== 'object') return;
      const agentId = data.agentId ?? data.id;
      if (typeof agentId !== 'number') return;
      setAnimals((prev) => {
        const a = prev.get(agentId);
        if (!a) return prev;
        const next = new Map(prev);
        if (data.type === 'agentToolStart') {
          next.set(agentId, { ...a, state: 'working', toolHint: data.toolName ?? 'tool' });
        } else if (data.type === 'agentToolDone') {
          next.set(agentId, { ...a, state: 'idle', toolHint: '' });
        } else if (data.type === 'agentToolClear') {
          next.set(agentId, { ...a, state: 'idle', toolHint: '' });
        } else if (data.type === 'agentStatus') {
          const ad = data as { status?: string };
          next.set(agentId, { ...a, state: ad.status === 'waiting' ? 'waiting' : a.state });
        }
        return next;
      });
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Animation loop: gentle random walk + edge bounce ─────────────────
  useEffect(() => {
    let raf = 0;
    function tick(): void {
      setAnimals((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        const ids = Array.from(next.keys());
        const arr = ids.map((id) => next.get(id)!);
        for (const a of arr) {
          // Random nudge so motion feels alive.
          a.vx += (Math.random() - 0.5) * 0.0002;
          a.vy += (Math.random() - 0.5) * 0.0002;
          // Damp.
          a.vx *= 0.98;
          a.vy *= 0.98;
          // Move.
          a.x += a.vx;
          a.y += a.vy;
          // Edge bounce.
          if (a.x < 0.04) { a.x = 0.04; a.vx = Math.abs(a.vx); }
          if (a.x > 0.96) { a.x = 0.96; a.vx = -Math.abs(a.vx); }
          if (a.y < 0.10) { a.y = 0.10; a.vy = Math.abs(a.vy); }
          if (a.y > 0.92) { a.y = 0.92; a.vy = -Math.abs(a.vy); }
        }
        // Detect close pairs and trigger a wave.
        const now = Date.now();
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            const dx = arr[i].x - arr[j].x;
            const dy = arr[i].y - arr[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 0.08 && now - arr[i].lastWaveAt > 4000) {
              arr[i].lastWaveAt = now;
              arr[j].lastWaveAt = now;
            }
          }
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onCanvasClick = useCallback((): void => {
    // Nudge each animal slightly on canvas click — fun bit of life.
    setAnimals((prev) => {
      const next = new Map(prev);
      for (const a of next.values()) {
        a.vx += (Math.random() - 0.5) * 0.01;
        a.vy += (Math.random() - 0.5) * 0.01;
      }
      return next;
    });
  }, []);

  return (
    <div
      ref={containerRef}
      onClick={onCanvasClick}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background:
          'radial-gradient(ellipse at top, color-mix(in srgb, var(--color-accent) 8%, var(--color-bg)) 0%, var(--color-bg) 70%)',
        overflow: 'hidden',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      {projectName && (
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '14px 28px',
            background: 'var(--color-bg-dark)',
            border: '2px solid var(--color-border)',
            boxShadow: 'var(--shadow-pixel)',
            fontSize: '24px',
            letterSpacing: '0.05em',
            zIndex: 5,
            pointerEvents: 'none',
          }}
        >
          🌿 {projectName}
        </div>
      )}
      {Array.from(animals.values()).map((a) => {
        // Note: Date.now() / Math.sin reads here are visual decoration only;
        // freshness is driven by the rAF loop's setState. Lint suppressed
        // where the rule fires.
        // eslint-disable-next-line react-hooks/purity
        const now = Date.now();
        const wavingNow = now - a.lastWaveAt < 1500;
        const scale = a.state === 'working' ? 1.15 : a.state === 'waiting' ? 0.92 : 1;
        const bob = a.state === 'working' ? `translateY(${Math.sin(now / 120) * 6}px)` : '';
        return (
          <div
            key={a.id}
            style={{
              position: 'absolute',
              left: `${a.x * 100}%`,
              top: `${a.y * 100}%`,
              transform: `translate(-50%, -50%) ${bob} scale(${scale})`,
              transition: 'transform 0.2s ease-out, left 0.05s linear, top 0.05s linear',
              filter: `hue-rotate(${a.hue}deg) drop-shadow(0 4px 0 var(--color-bg-dark))`,
              fontSize: '64px',
              userSelect: 'none',
              pointerEvents: 'none',
              textAlign: 'center',
            }}
            title={`${a.label} — ${a.state}${a.toolHint ? ` (${a.toolHint})` : ''}`}
          >
            <div style={{ lineHeight: 1 }}>{a.emoji}</div>
            <div
              style={{
                fontSize: '11px',
                marginTop: '2px',
                background: 'var(--color-bg-dark)',
                color: 'var(--color-text)',
                padding: '2px 6px',
                border: '1px solid var(--color-border)',
                whiteSpace: 'nowrap',
                filter: `hue-rotate(-${a.hue}deg)`, // counter the parent hue so labels stay legible
              }}
            >
              {a.label}
            </div>
            {a.state === 'working' && a.toolHint && (
              <div
                style={{
                  position: 'absolute',
                  top: '-22px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  fontSize: '12px',
                  background: 'var(--color-accent)',
                  color: 'var(--color-bg-dark)',
                  padding: '2px 8px',
                  border: '2px solid var(--color-border)',
                  whiteSpace: 'nowrap',
                  filter: `hue-rotate(-${a.hue}deg)`,
                }}
              >
                {a.toolHint}
              </div>
            )}
            {wavingNow && (
              <div
                style={{
                  position: 'absolute',
                  top: '-30px',
                  right: '-10px',
                  fontSize: '24px',
                  filter: `hue-rotate(-${a.hue}deg)`,
                  animation: 'tama-wave 1s ease-in-out',
                }}
              >
                👋
              </div>
            )}
          </div>
        );
      })}
      {animals.size === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'var(--color-text-muted)',
            fontSize: '14px',
            textAlign: 'center',
          }}
        >
          No companions yet.
          <br />
          Click <strong>+ Agent</strong> to spawn one.
        </div>
      )}
      <style>{`
        @keyframes tama-wave {
          0%, 100% { transform: translate(-50%, 0) rotate(0deg); }
          25% { transform: translate(-50%, -4px) rotate(-15deg); }
          75% { transform: translate(-50%, -4px) rotate(15deg); }
        }
      `}</style>
    </div>
  );
}
