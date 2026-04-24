/* eslint-disable pixel-agents/no-inline-colors */
// Pixel monster sprite renderer — colors drawn directly into a <canvas>;
// CSS variables can't be sampled here so concrete RGB literals are necessary.
import { useEffect, useRef } from 'react';

const SIZE = 16; // 16x16 pixel grid
const SCALE = 4; // each pixel rendered as 4×4 css px → 64×64 sprite

/** djb2-ish hash → uint32. Same string always returns the same number. */
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
    // xorshift32
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    return Math.abs(this.state);
  }
  range(min: number, max: number): number {
    return min + (this.next() % (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.next() % arr.length];
  }
}

/** Convert HSL → hex string for canvas fillStyle. */
function hsl(h: number, s: number, l: number): string {
  return `hsl(${h % 360}, ${s}%, ${l}%)`;
}

/**
 * Renders a procedural pixel-art monster into the given canvas. The same
 * `seed` always produces the same creature (deterministic). The design is
 * a chubby blob with two eyes, a small mouth, and a randomly-tinted body.
 * Mirrored on the X axis so it always looks symmetric.
 */
function renderMonster(canvas: HTMLCanvasElement, seed: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, SIZE * SCALE, SIZE * SCALE);

  const rng = new Rng(seed);
  const baseHue = rng.range(0, 359);
  const accentHue = (baseHue + rng.range(120, 240)) % 360;
  const bodyLight = rng.range(50, 65);
  const body = hsl(baseHue, 70, bodyLight);
  const bodyDark = hsl(baseHue, 70, bodyLight - 18);
  const accent = hsl(accentHue, 80, 65);
  const eyeWhite = '#f6f0e0';
  const eyePupil = '#0a0a14';

  // Body silhouette (mirrored). Encoded as a half-grid (8 cols).
  // 0 = transparent, 1 = body, 2 = body shadow, 3 = accent.
  const half: number[][] = [];
  for (let y = 0; y < SIZE; y++) half.push(new Array(SIZE / 2).fill(0));

  // Carve a chubby blob. Width per row roughly follows a vertical bell curve.
  for (let y = 2; y < SIZE - 2; y++) {
    const t = (y - 2) / (SIZE - 4);
    // bell-ish: wider in the middle, narrow at top/bottom
    const widthFactor = Math.sin(t * Math.PI);
    const w = Math.max(2, Math.round(2 + widthFactor * (SIZE / 2 - 1) * 0.95));
    for (let x = 0; x < w; x++) {
      // Bottom row → shadow
      half[y][x] = y >= SIZE - 4 ? 2 : 1;
    }
  }

  // Random feet at the bottom (1-2 stubs).
  const footRow = SIZE - 2;
  const footCols: number[] = [];
  footCols.push(rng.range(1, 3));
  if (rng.next() % 2 === 0) footCols.push(rng.range(4, 6));
  for (const x of footCols) {
    if (x < SIZE / 2 && half[footRow] && half[footRow][x] === 0) {
      half[footRow][x] = 2;
    }
  }

  // Random "type" speckles (accent color) — couple of dots.
  for (let i = 0; i < 4; i++) {
    const x = rng.range(0, SIZE / 2 - 2);
    const y = rng.range(4, SIZE - 5);
    if (half[y][x] === 1) half[y][x] = 3;
  }

  // Eyes (inset from edge, around the upper third).
  const eyeRow = rng.range(5, 7);
  const eyeCol = rng.range(2, Math.floor(SIZE / 2) - 2);

  // Mouth (single pixel), only on the centerline (we duplicate its mirror).
  const mouthRow = rng.range(eyeRow + 1, eyeRow + 3);

  // ── Render ──
  function px(x: number, y: number, color: string): void {
    ctx!.fillStyle = color;
    ctx!.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
  }

  for (let y = 0; y < SIZE; y++) {
    for (let xh = 0; xh < SIZE / 2; xh++) {
      const v = half[y][xh];
      if (v === 0) continue;
      const color = v === 1 ? body : v === 2 ? bodyDark : accent;
      // Mirror left + right halves around the centerline (no center column).
      const xLeft = SIZE / 2 - 1 - xh;
      const xRight = SIZE / 2 + xh;
      px(xLeft, y, color);
      px(xRight, y, color);
    }
  }

  // Eyes (white sclera + dark pupil), one per side.
  for (const sign of [-1, 1]) {
    const cx = SIZE / 2 + sign * eyeCol;
    if (cx < 1 || cx >= SIZE - 1) continue;
    px(cx, eyeRow, eyeWhite);
    px(cx, eyeRow, eyePupil);
  }

  // Mouth (centered, one pixel).
  if (mouthRow < SIZE - 3) {
    px(SIZE / 2 - 1, mouthRow, eyePupil);
    px(SIZE / 2, mouthRow, eyePupil);
  }
}

interface Props {
  /** Anything string-y; same value → same creature. */
  seed: string;
  /** Optional css class for sizing/transform overrides. */
  className?: string;
  /** Pixels per sprite-pixel (default 4 → 64×64 sprite). */
  scale?: number;
}

export function PixelMonster({ seed, scale, className }: Props): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const px = scale ?? SCALE;
  useEffect(() => {
    if (!ref.current) return;
    renderMonster(ref.current, hash(seed));
  }, [seed]);
  return (
    <canvas
      ref={ref}
      width={SIZE * SCALE}
      height={SIZE * SCALE}
      className={className}
      style={{
        width: `${SIZE * px}px`,
        height: `${SIZE * px}px`,
        imageRendering: 'pixelated',
        display: 'block',
      }}
    />
  );
}
