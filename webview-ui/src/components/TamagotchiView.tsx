/* eslint-disable pixel-agents/no-inline-colors */
// Tamagotchi-style "rolling balls" world: each claude session is a colored
// ball that drifts, collides elastically with the others, and is clickable
// to focus its terminal session in the BottomPanel.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { TerminalEntry } from '../hooks/useTerminals';

// ── Deterministic hash + RNG ─────────────────────────────────────────────
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface BallLook {
  bodyColor: string;
  accentColor: string;
  /** 'plain' | 'stripe' | 'dot' | 'swirl' — ornament drawn on top */
  pattern: 'plain' | 'stripe' | 'dot' | 'swirl';
  faceTilt: number; // -10..10
}

const PATTERNS: BallLook['pattern'][] = ['plain', 'stripe', 'dot', 'swirl'];

function makeLook(seed: string): BallLook {
  const h = hashString(seed);
  const baseHue = h % 360;
  const accentHue = (baseHue + 180 + ((h >> 4) % 60) - 30) % 360;
  return {
    bodyColor: `hsl(${baseHue}, 75%, 60%)`,
    accentColor: `hsl(${accentHue}, 80%, 70%)`,
    pattern: PATTERNS[(h >> 7) % PATTERNS.length],
    faceTilt: ((h >> 11) % 20) - 10,
  };
}

const RADIUS = 36; // px — visual + physics radius
const CHATTER = ['hi', 'yo', '!', '?', '<3', '*', 'play', '~'] as const;

interface Ball {
  id: number;
  termId: string;
  label: string;
  seed: string;
  look: BallLook;
  // Physics in PIXEL space (viewport units), not normalized — so collisions
  // map 1:1 to visible distance.
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number; // visual roll angle, derived from velocity
  bornAt: number;
  speech: string | null;
  speechUntil: number;
  active: boolean; // currently working (claude tool_use)
}

interface Props {
  terminals: TerminalEntry[];
  /** Called when the user clicks a ball — should focus that session. */
  onSelectSession: (termId: string) => void;
}

export function TamagotchiView({ terminals, onSelectSession }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [balls, setBalls] = useState<Map<number, Ball>>(new Map());
  const [size, setSize] = useState({ w: 800, h: 600 });

  // Track container size so physics stays inside the visible area.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (): void => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sync balls with the agent list (add new, drop removed). Same projectId+slot
  // → same look, so the appearance survives reload + persists across sessions.
  useEffect(() => {
    setBalls((prev) => {
      const next = new Map(prev);
      const claude = terminals.filter((t) => t.kind === 'claude');
      claude.forEach((t, idx) => {
        if (next.has(t.agentId)) {
          // Update the label in case it was renamed.
          const existing = next.get(t.agentId)!;
          if (existing.label !== t.label) {
            next.set(t.agentId, { ...existing, label: t.label });
          }
          return;
        }
        const seed = `${t.projectId}#${idx}`;
        next.set(t.agentId, {
          id: t.agentId,
          termId: t.id,
          label: t.label,
          seed,
          look: makeLook(seed),
          x: RADIUS + Math.random() * Math.max(50, size.w - RADIUS * 2),
          y: RADIUS + Math.random() * Math.max(50, size.h - RADIUS * 2),
          vx: (Math.random() - 0.5) * 60,
          vy: (Math.random() - 0.5) * 60,
          rotation: 0,
          bornAt: Date.now(),
          speech: null,
          speechUntil: 0,
          active: false,
        });
      });
      const present = new Set(claude.map((t) => t.agentId));
      for (const id of next.keys()) {
        if (!present.has(id)) next.delete(id);
      }
      return next;
    });
  }, [terminals, size.w, size.h]);

  // Subscribe to agent activity → set active flag (used for visible glow + face).
  useEffect(() => {
    function handler(ev: MessageEvent): void {
      const data = ev.data as { type?: string; agentId?: number; id?: number };
      if (!data || typeof data !== 'object') return;
      const aid = data.agentId ?? data.id;
      if (typeof aid !== 'number') return;
      setBalls((prev) => {
        const b = prev.get(aid);
        if (!b) return prev;
        const next = new Map(prev);
        if (data.type === 'agentToolStart') next.set(aid, { ...b, active: true });
        else if (data.type === 'agentToolDone' || data.type === 'agentToolClear')
          next.set(aid, { ...b, active: false });
        return next;
      });
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Physics + collisions, driven by rAF. Updates positions/velocities.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    function tick(now: number): void {
      const dt = Math.min(0.05, (now - last) / 1000); // cap dt at 50ms
      last = now;
      setBalls((prev) => {
        if (prev.size === 0) return prev;
        const arr = Array.from(prev.values());
        const w = size.w;
        const h = size.h;

        // Move + edge bounce. (No header reserve anymore — project name lives
        // in the top tab bar above the canvas, not floating inside it.)
        for (const b of arr) {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          // Damp gently so motion stays calm
          b.vx *= 0.997;
          b.vy *= 0.997;
          // Apply random tiny drift so balls keep moving
          b.vx += (Math.random() - 0.5) * 4;
          b.vy += (Math.random() - 0.5) * 4;
          // Edge bounce
          if (b.x - RADIUS < 0) { b.x = RADIUS; b.vx = Math.abs(b.vx); }
          if (b.x + RADIUS > w) { b.x = w - RADIUS; b.vx = -Math.abs(b.vx); }
          if (b.y - RADIUS < 0) { b.y = RADIUS; b.vy = Math.abs(b.vy); }
          if (b.y + RADIUS > h) { b.y = h - RADIUS; b.vy = -Math.abs(b.vy); }
        }

        // Pairwise elastic collisions (equal mass).
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i];
            const b = arr[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = RADIUS * 2;
            if (dist === 0 || dist >= minDist) continue;
            // Normal direction
            const nx = dx / dist;
            const ny = dy / dist;
            // Separate so they stop overlapping
            const overlap = (minDist - dist) / 2;
            a.x -= nx * overlap;
            a.y -= ny * overlap;
            b.x += nx * overlap;
            b.y += ny * overlap;
            // Velocity along the normal
            const va = a.vx * nx + a.vy * ny;
            const vb = b.vx * nx + b.vy * ny;
            // Equal-mass elastic: swap normal components
            const da = vb - va;
            a.vx += da * nx;
            a.vy += da * ny;
            b.vx -= da * nx;
            b.vy -= da * ny;
            // Tiny chatter on collision
            const nowMs = Date.now();
            if (nowMs - a.speechUntil > 1800 && Math.random() < 0.4) {
              a.speech = CHATTER[Math.floor(Math.random() * CHATTER.length)];
              a.speechUntil = nowMs + 1200;
            }
            if (nowMs - b.speechUntil > 1800 && Math.random() < 0.4) {
              b.speech = CHATTER[Math.floor(Math.random() * CHATTER.length)];
              b.speechUntil = nowMs + 1200;
            }
          }
        }

        // Update visual rotation based on horizontal velocity (rolling effect).
        const nowMs = Date.now();
        for (const b of arr) {
          b.rotation += (b.vx * dt) / RADIUS * (180 / Math.PI);
          if (b.speech && nowMs > b.speechUntil) b.speech = null;
        }

        // Build new map (state immutability light — we mutated in place; React
        // will see a new Map so it re-renders).
        return new Map(arr.map((b) => [b.id, b]));
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [size.w, size.h]);

  const onBallClick = useCallback(
    (b: Ball, e: React.MouseEvent) => {
      e.stopPropagation();
      onSelectSession(b.termId);
      // Give it a little bump for feedback
      setBalls((prev) => {
        const next = new Map(prev);
        const cur = next.get(b.id);
        if (cur) {
          next.set(b.id, {
            ...cur,
            vx: cur.vx + (Math.random() - 0.5) * 200,
            vy: cur.vy - 60,
            speech: '!',
            speechUntil: Date.now() + 700,
          });
        }
        return next;
      });
    },
    [onSelectSession],
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background:
          'radial-gradient(ellipse at top, color-mix(in srgb, var(--color-accent) 8%, var(--color-bg)) 0%, var(--color-bg) 70%)',
        backgroundImage:
          'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px), radial-gradient(ellipse at top, color-mix(in srgb, var(--color-accent) 8%, var(--color-bg)) 0%, var(--color-bg) 70%)',
        backgroundSize: '24px 24px, 24px 24px, 100% 100%',
        overflow: 'hidden',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      {Array.from(balls.values()).map((b) => (
        <BallView key={b.id} ball={b} onClick={(e) => onBallClick(b, e)} />
      ))}
      {balls.size === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'var(--color-text-muted)',
            fontSize: '16px',
            textAlign: 'center',
          }}
        >
          No companions yet. Click <strong>+ Session</strong> to spawn one.
        </div>
      )}
    </div>
  );
}

// ── Single ball renderer ─────────────────────────────────────────────────
function BallView({
  ball,
  onClick,
}: {
  ball: Ball;
  onClick: (e: React.MouseEvent) => void;
}): React.JSX.Element {
  const { x, y, rotation, look, label, speech, active } = ball;
  return (
    <div
      onClick={onClick}
      style={{
        position: 'absolute',
        left: `${x - RADIUS}px`,
        top: `${y - RADIUS}px`,
        width: `${RADIUS * 2}px`,
        height: `${RADIUS * 2}px`,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      title={`${label} — click to focus`}
    >
      {speech && (
        <div
          style={{
            position: 'absolute',
            bottom: `${RADIUS * 2 - 8}px`,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--color-bg-dark)',
            color: 'var(--color-text)',
            border: '2px solid var(--color-border)',
            boxShadow: 'var(--shadow-pixel)',
            padding: '2px 6px',
            fontSize: '13px',
            fontFamily: 'var(--font-pixel)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {speech}
        </div>
      )}
      {/* Ball — circle div with rolling rotation. The pattern is drawn via
          a child div so it counter-rotates only when needed (not currently). */}
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          background: `radial-gradient(circle at 35% 30%, color-mix(in srgb, ${look.bodyColor} 70%, white) 0%, ${look.bodyColor} 50%, color-mix(in srgb, ${look.bodyColor} 60%, black) 100%)`,
          border: '3px solid #0a0a14',
          boxShadow: active
            ? `0 0 0 4px var(--color-accent), 4px 6px 0 rgba(0,0,0,0.45)`
            : `4px 6px 0 rgba(0,0,0,0.45)`,
          position: 'relative',
          transform: `rotate(${rotation}deg)`,
          overflow: 'hidden',
        }}
      >
        {look.pattern === 'stripe' && (
          <div
            style={{
              position: 'absolute',
              top: '40%',
              left: '-10%',
              width: '120%',
              height: '20%',
              background: look.accentColor,
              border: '2px solid #0a0a14',
            }}
          />
        )}
        {look.pattern === 'dot' && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: '32%',
              height: '32%',
              transform: 'translate(-50%, -50%)',
              borderRadius: '50%',
              background: look.accentColor,
              border: '2px solid #0a0a14',
            }}
          />
        )}
        {look.pattern === 'swirl' && (
          <div
            style={{
              position: 'absolute',
              inset: '15%',
              borderRadius: '50%',
              border: `4px dashed ${look.accentColor}`,
            }}
          />
        )}
      </div>
      {/* Label below the ball, NOT rotated. */}
      <div
        style={{
          position: 'absolute',
          top: `${RADIUS * 2 + 4}px`,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: '13px',
          fontFamily: 'var(--font-pixel)',
          background: 'var(--color-bg-dark)',
          color: 'var(--color-text)',
          padding: '2px 6px',
          border: '1px solid var(--color-border)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        {label}
      </div>
    </div>
  );
}
