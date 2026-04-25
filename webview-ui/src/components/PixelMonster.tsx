/* eslint-disable pixel-agents/no-inline-colors */
// Pixel monster sprite renderer — colors painted directly onto a <canvas>.
// CSS variables can't be sampled here, so concrete RGB literals are necessary.
import { useEffect, useRef } from 'react';

const SIZE = 24; // 24x24 pixel grid — bigger than v1 for more shape detail
const SCALE = 4; // each pixel = 4×4 css px → 96×96 sprite

// ── deterministic seeded RNG ────────────────────────────────────────────────
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed || 1;
  }
  next(): number {
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    return Math.abs(this.state);
  }
  range(min: number, max: number): number {
    return min + (this.next() % (max - min + 1));
  }
  bool(p = 0.5): boolean {
    return (this.next() % 1000) / 1000 < p;
  }
}

function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
}

// 3 archetypes — round, tall, blob
type Shape = 'round' | 'tall' | 'blob';
const SHAPES: Shape[] = ['round', 'tall', 'blob'];

interface Palette {
  body: string;
  shade: string;
  belly: string;
  accent: string;
  eyeWhite: string;
  eyePupil: string;
  outline: string;
}

function buildPalette(rng: Rng): Palette {
  const baseHue = rng.range(0, 359);
  const accentHue = (baseHue + rng.range(110, 250)) % 360;
  const lightness = rng.range(54, 66);
  return {
    body: hsl(baseHue, 70, lightness),
    shade: hsl(baseHue, 70, lightness - 20),
    belly: hsl(baseHue, 50, Math.min(80, lightness + 18)),
    accent: hsl(accentHue, 80, 65),
    eyeWhite: '#f6f0e0',
    eyePupil: '#0a0a14',
    outline: hsl(baseHue, 60, Math.max(15, lightness - 38)),
  };
}

/** Draw a half-grid silhouette → mirrored body for the chosen archetype. */
function bodySilhouette(rng: Rng, shape: Shape): number[][] {
  const grid: number[][] = [];
  for (let y = 0; y < SIZE; y++) grid.push(new Array(SIZE / 2).fill(0));
  // 1 = body, 2 = shade (bottom rim), 3 = belly, 4 = accent

  if (shape === 'round') {
    // Big round body, small head fused on top
    const cx = 0; // half-grid centerline
    const cy = 14;
    const ry = 7;
    const rx = 9;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE / 2; x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) grid[y][x] = 1;
      }
    }
    // Belly oval
    for (let y = 14; y < 20; y++) {
      for (let x = 0; x < 5; x++) if (grid[y][x] === 1) grid[y][x] = 3;
    }
    // Bottom rim shade
    for (let y = 19; y < 21; y++) {
      for (let x = 0; x < SIZE / 2; x++) if (grid[y][x] !== 0) grid[y][x] = 2;
    }
  } else if (shape === 'tall') {
    // Slim upright with a head bump
    const headTop = 3;
    const headBot = 10;
    const bodyTop = 10;
    const bodyBot = 21;
    // Head (smaller circle)
    for (let y = headTop; y <= headBot; y++) {
      const t = (y - headTop) / (headBot - headTop);
      const w = Math.max(2, Math.round(2 + Math.sin(t * Math.PI) * 5));
      for (let x = 0; x < w; x++) grid[y][x] = 1;
    }
    // Body (taller oval)
    for (let y = bodyTop; y <= bodyBot; y++) {
      const t = (y - bodyTop) / (bodyBot - bodyTop);
      const w = Math.max(3, Math.round(3 + Math.sin(t * Math.PI) * 5));
      for (let x = 0; x < w; x++) grid[y][x] = 1;
    }
    // Belly
    for (let y = 13; y < 20; y++) for (let x = 0; x < 4; x++) if (grid[y][x] === 1) grid[y][x] = 3;
    for (let y = 20; y < 22; y++) for (let x = 0; x < SIZE / 2; x++) if (grid[y][x] !== 0) grid[y][x] = 2;
  } else {
    // Blob — squat amorphous shape
    for (let y = 8; y < 21; y++) {
      const t = (y - 8) / 12;
      const w = Math.max(2, Math.round(3 + Math.sin(t * Math.PI) * 7));
      for (let x = 0; x < w; x++) grid[y][x] = 1;
    }
    // Tiny ears / antennae (2 stubs at top)
    if (rng.bool(0.7)) {
      grid[7][2] = 1;
      grid[6][2] = 1;
    }
    for (let y = 14; y < 19; y++) for (let x = 0; x < 4; x++) if (grid[y][x] === 1) grid[y][x] = 3;
    for (let y = 19; y < 21; y++) for (let x = 0; x < SIZE / 2; x++) if (grid[y][x] !== 0) grid[y][x] = 2;
  }

  // Random accent dots on body
  for (let i = 0; i < 3; i++) {
    const x = rng.range(1, SIZE / 2 - 2);
    const y = rng.range(8, 18);
    if (grid[y][x] === 1) grid[y][x] = 4;
  }
  return grid;
}

interface FaceMeta {
  eyeRow: number;
  eyeColFromCenter: number;
  hasMouth: boolean;
  mouthRow: number;
}

function pickFace(rng: Rng, shape: Shape): FaceMeta {
  const eyeRow = shape === 'tall' ? rng.range(5, 8) : shape === 'round' ? rng.range(10, 12) : rng.range(11, 13);
  const eyeColFromCenter = rng.range(2, 4);
  const hasMouth = rng.bool(0.85);
  const mouthRow = eyeRow + rng.range(2, 3);
  return { eyeRow, eyeColFromCenter, hasMouth, mouthRow };
}

function renderMonster(
  canvas: HTMLCanvasElement,
  seed: number,
  options: { blink?: boolean; happy?: boolean } = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, SIZE * SCALE, SIZE * SCALE);

  const rng = new Rng(seed);
  const shape = SHAPES[rng.next() % SHAPES.length];
  const palette = buildPalette(rng);
  const grid = bodySilhouette(rng, shape);
  const face = pickFace(rng, shape);

  function px(x: number, y: number, color: string): void {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    ctx!.fillStyle = color;
    ctx!.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
  }

  // ── 1. Body (mirrored) ───────────────────────────────────────────────
  for (let y = 0; y < SIZE; y++) {
    for (let xh = 0; xh < SIZE / 2; xh++) {
      const v = grid[y][xh];
      if (v === 0) continue;
      const color =
        v === 1 ? palette.body : v === 2 ? palette.shade : v === 3 ? palette.belly : palette.accent;
      const xLeft = SIZE / 2 - 1 - xh;
      const xRight = SIZE / 2 + xh;
      px(xLeft, y, color);
      px(xRight, y, color);
    }
  }

  // ── 2. 1px outline around the body silhouette ───────────────────────
  const bodyMask: boolean[][] = [];
  for (let y = 0; y < SIZE; y++) {
    bodyMask.push(new Array(SIZE).fill(false));
    for (let x = 0; x < SIZE; x++) {
      const xh = x < SIZE / 2 ? SIZE / 2 - 1 - x : x - SIZE / 2;
      bodyMask[y][x] = grid[y][xh] !== 0;
    }
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (bodyMask[y][x]) continue;
      // Adjacent to body? Paint outline
      const adj =
        (y > 0 && bodyMask[y - 1][x]) ||
        (y < SIZE - 1 && bodyMask[y + 1][x]) ||
        (x > 0 && bodyMask[y][x - 1]) ||
        (x < SIZE - 1 && bodyMask[y][x + 1]);
      if (adj) px(x, y, palette.outline);
    }
  }

  // ── 3. Eyes ──────────────────────────────────────────────────────────
  for (const sign of [-1, 1]) {
    const cx = SIZE / 2 + sign * face.eyeColFromCenter - (sign < 0 ? 1 : 0);
    if (cx < 1 || cx >= SIZE - 1) continue;
    if (options.blink) {
      // Closed eye: 1px line of pupil color
      px(cx, face.eyeRow, palette.eyePupil);
    } else {
      // Big eye: 2x2 sclera + 1px pupil
      px(cx, face.eyeRow, palette.eyeWhite);
      px(cx, face.eyeRow + 1, palette.eyeWhite);
      px(cx + (sign < 0 ? 1 : -1), face.eyeRow, palette.eyeWhite);
      px(cx, face.eyeRow, palette.eyePupil);
    }
  }

  // ── 4. Mouth ─────────────────────────────────────────────────────────
  if (face.hasMouth && face.mouthRow < SIZE - 3) {
    if (options.happy) {
      // Smile: 3 pixels in a U
      px(SIZE / 2 - 2, face.mouthRow, palette.eyePupil);
      px(SIZE / 2 - 1, face.mouthRow + 1, palette.eyePupil);
      px(SIZE / 2, face.mouthRow + 1, palette.eyePupil);
      px(SIZE / 2 + 1, face.mouthRow, palette.eyePupil);
    } else {
      px(SIZE / 2 - 1, face.mouthRow, palette.eyePupil);
      px(SIZE / 2, face.mouthRow, palette.eyePupil);
    }
  }

  // ── 5. Cheek blushes (if happy) ──────────────────────────────────────
  if (options.happy) {
    const cheekRow = face.eyeRow + 1;
    px(SIZE / 2 - 5, cheekRow, palette.accent);
    px(SIZE / 2 + 4, cheekRow, palette.accent);
  }
}

interface Props {
  /** Anything string-y; same value → same creature. */
  seed: string;
  /** Pixels per sprite-pixel (default 4 → 96×96 sprite). */
  scale?: number;
  /** Show closed eyes for one frame (blink animation). */
  blink?: boolean;
  /** Show smile + cheeks (interaction state). */
  happy?: boolean;
}

export function PixelMonster({ seed, scale, blink, happy }: Props): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const px = scale ?? SCALE;
  useEffect(() => {
    if (!ref.current) return;
    renderMonster(ref.current, hash(seed), { blink, happy });
  }, [seed, blink, happy]);
  return (
    <canvas
      ref={ref}
      width={SIZE * SCALE}
      height={SIZE * SCALE}
      style={{
        width: `${SIZE * px}px`,
        height: `${SIZE * px}px`,
        imageRendering: 'pixelated',
        display: 'block',
      }}
    />
  );
}
