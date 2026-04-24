/* eslint-disable pixel-agents/no-inline-colors */
// The grid-overlay background uses inline rgba so it can layer on top of the
// existing radial gradient — replacing it with a CSS variable would force a
// new --color-* token for a single-use ornament. Pragmatic exemption.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { TerminalEntry } from '../hooks/useTerminals';
import { Companion, type Emotion } from './Companion';

type AgentState = 'idle' | 'working' | 'waiting';

interface Animal {
  id: number;
  termId: string;
  label: string;
  /** Seed for the companion design (stable per project + slot). */
  seed: string;
  x: number;         // 0..1 normalized
  y: number;         // 0..1 normalized
  vx: number;        // velocity per frame, normalized
  vy: number;
  state: AgentState;
  toolHint: string;
  bornAt: number;
  lastWaveAt: number;
  /** Transient on-canvas speech bubble; auto-clears. */
  speech: string | null;
  speechUntil: number;
}

function pickEmotion(a: { state: AgentState; speech: string | null }, waving: boolean, blinking: boolean): Emotion {
  if (blinking) return 'sleepy';
  if (a.speech || waving) return 'excited';
  if (a.state === 'working') return 'working';
  if (a.state === 'waiting') return 'surprised';
  return 'happy';
}

const CHATTER = [
  'hi!', 'yo', 'wassup?', 'play?', '🎵', 'tag!', 'race?', 'lol',
  'hehe', '<3', '✨', 'wow', 'cool', 'tag', '!?',
] as const;

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
          // Project-deterministic seed; agent index nudges the design so multiple
          // agents in the same project look related but distinguishable.
          seed: `${t.projectId}#${indexWithinProject}`,
          x: 0.1 + Math.random() * 0.8,
          y: 0.2 + Math.random() * 0.6,
          vx: (Math.random() - 0.5) * 0.0015,
          vy: (Math.random() - 0.5) * 0.0015,
          state: 'idle',
          toolHint: '',
          bornAt: Date.now(),
          lastWaveAt: 0,
          speech: null,
          speechUntil: 0,
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
        } else if (data.type === 'agentRenamed') {
          const ad = data as { name?: string };
          if (ad.name) next.set(agentId, { ...a, label: ad.name });
        }
        return next;
      });
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Animation loop: random walk + occasional pair-seek + dance ───────
  useEffect(() => {
    let raf = 0;
    function tick(): void {
      setAnimals((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        const arr = Array.from(next.values());
        const now = Date.now();

        // For each animal, pick a "buddy" — the closest other one — and
        // gently steer toward them every few seconds. Otherwise random walk.
        for (let i = 0; i < arr.length; i++) {
          const a = arr[i];
          let buddy: typeof a | null = null;
          let bestDist = Infinity;
          for (let j = 0; j < arr.length; j++) {
            if (i === j) continue;
            const b = arr[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestDist) { bestDist = d; buddy = b; }
          }

          // Steering: when bored or working, drift toward the buddy.
          // Within 0.07 normalized units → trigger a dance.
          const seeking = a.state !== 'waiting' && buddy !== null && bestDist > 0.06;
          if (seeking && buddy) {
            const dx = buddy.x - a.x;
            const dy = buddy.y - a.y;
            const norm = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
            const pull = 0.00009;
            a.vx += (dx / norm) * pull;
            a.vy += (dy / norm) * pull;
          } else {
            // Random nudge so motion feels alive even when alone.
            a.vx += (Math.random() - 0.5) * 0.00018;
            a.vy += (Math.random() - 0.5) * 0.00018;
          }

          // Dance: when very close to a buddy, both hop + emit a speech bubble.
          if (buddy && bestDist < 0.07 && now - a.lastWaveAt > 3500) {
            a.lastWaveAt = now;
            a.vy -= 0.004;
            const word = CHATTER[Math.floor(Math.random() * CHATTER.length)];
            a.speech = word;
            a.speechUntil = now + 1800;
          }
          // Clear stale speech.
          if (a.speech && a.speechUntil < now) {
            a.speech = null;
          }

          // Damp + move.
          a.vx *= 0.96;
          a.vy *= 0.96;
          a.x += a.vx;
          a.y += a.vy;

          // Edge bounce.
          if (a.x < 0.04) { a.x = 0.04; a.vx = Math.abs(a.vx); }
          if (a.x > 0.96) { a.x = 0.96; a.vx = -Math.abs(a.vx); }
          if (a.y < 0.10) { a.y = 0.10; a.vy = Math.abs(a.vy); }
          if (a.y > 0.92) { a.y = 0.92; a.vy = -Math.abs(a.vy); }
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Blink loop: every animal blinks 1 frame every ~3-5 seconds ───────
  const [blinkTick, setBlinkTick] = useState<Set<number>>(new Set());
  useEffect(() => {
    const id = setInterval(() => {
      setBlinkTick((prev) => {
        const next = new Set(prev);
        // Random subset blinks; cleared after 200ms by a follow-up timer.
        const ids = Array.from(animalsRef.current.keys());
        for (const aId of ids) {
          if (Math.random() < 0.25) next.add(aId);
        }
        return next;
      });
      setTimeout(() => setBlinkTick(new Set()), 180);
    }, 2200);
    return () => clearInterval(id);
  }, []);
  // Mirror animals state in a ref so the blink loop can read it cheaply.
  const animalsRef = useRef(animals);
  useEffect(() => {
    animalsRef.current = animals;
  }, [animals]);

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
        backgroundImage:
          'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px), radial-gradient(ellipse at top, color-mix(in srgb, var(--color-accent) 8%, var(--color-bg)) 0%, var(--color-bg) 70%)',
        backgroundSize: '24px 24px, 24px 24px, 100% 100%',
        overflow: 'hidden',
        fontFamily: 'var(--font-pixel)',
        imageRendering: 'pixelated',
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
              filter: 'drop-shadow(0 4px 0 var(--color-bg-dark))',
              userSelect: 'none',
              pointerEvents: 'none',
              textAlign: 'center',
            }}
            title={`${a.label} — ${a.state}${a.toolHint ? ` (${a.toolHint})` : ''}`}
          >
            <Companion
              seed={a.seed}
              size={88}
              emotion={pickEmotion(a, wavingNow, blinkTick.has(a.id))}
              speech={a.speech}
            />
            <div
              style={{
                fontSize: '11px',
                marginTop: '4px',
                background: 'var(--color-bg-dark)',
                color: 'var(--color-text)',
                padding: '2px 6px',
                border: '1px solid var(--color-border)',
                whiteSpace: 'nowrap',
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
