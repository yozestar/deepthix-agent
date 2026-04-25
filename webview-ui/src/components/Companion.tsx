/* eslint-disable pixel-agents/no-inline-colors */
// 2D SVG companion blob with expressive faces. Body color/shape are seeded
// from a string (so each project gets a stable look). Emotion changes the
// face: eyes, mouth, eyebrows.

export type Emotion = 'idle' | 'happy' | 'working' | 'sleepy' | 'excited' | 'surprised';

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pick<T>(seed: number, arr: readonly T[]): T {
  return arr[seed % arr.length];
}

const SHAPES = ['circle', 'oval', 'pill'] as const;
type Shape = (typeof SHAPES)[number];

interface Look {
  shape: Shape;
  bodyColor: string;
  bellyColor: string;
  hairColor: string;
  hasHorn: boolean;
  hasEars: boolean;
}

function makeLook(seed: string): Look {
  const h = hash(seed);
  const baseHue = h % 360;
  const accentHue = (baseHue + 180) % 360;
  return {
    shape: pick(h, SHAPES),
    bodyColor: `hsl(${baseHue}, 70%, 62%)`,
    bellyColor: `hsl(${baseHue}, 50%, 80%)`,
    hairColor: `hsl(${accentHue}, 75%, 55%)`,
    hasHorn: (h >> 3) % 4 === 0,
    hasEars: (h >> 5) % 3 !== 0,
  };
}

interface FaceParts {
  eyeShape: 'open' | 'closed' | 'wide' | 'tilt';
  mouth: 'smile' | 'neutral' | 'O' | 'flat' | 'tongue';
  eyebrows: 'flat' | 'raised' | 'angry' | 'none';
  cheeks: boolean;
  zzz: boolean;
}

function emotionToFace(e: Emotion): FaceParts {
  switch (e) {
    case 'happy':     return { eyeShape: 'open',   mouth: 'smile',   eyebrows: 'raised', cheeks: true,  zzz: false };
    case 'working':   return { eyeShape: 'open',   mouth: 'O',       eyebrows: 'flat',   cheeks: false, zzz: false };
    case 'sleepy':    return { eyeShape: 'closed', mouth: 'flat',    eyebrows: 'none',   cheeks: false, zzz: true  };
    case 'excited':   return { eyeShape: 'wide',   mouth: 'tongue',  eyebrows: 'raised', cheeks: true,  zzz: false };
    case 'surprised': return { eyeShape: 'wide',   mouth: 'O',       eyebrows: 'raised', cheeks: false, zzz: false };
    case 'idle':
    default:          return { eyeShape: 'open',   mouth: 'neutral', eyebrows: 'flat',   cheeks: false, zzz: false };
  }
}

interface Props {
  /** Stable identifier — same value → same body. */
  seed: string;
  /** Pixel size of the bounding box (defaults to 88). */
  size?: number;
  /** Current emotion. */
  emotion?: Emotion;
  /** When set, mouth says this for ~2s (rendered as a small bubble). */
  speech?: string | null;
}

export function Companion({ seed, size, emotion, speech }: Props): React.JSX.Element {
  const px = size ?? 88;
  const look = makeLook(seed);
  const face = emotionToFace(emotion ?? 'idle');
  // SVG viewbox 100×100, centered
  return (
    <div
      style={{
        position: 'relative',
        width: `${px}px`,
        height: `${px}px`,
        display: 'inline-block',
      }}
    >
      <svg
        viewBox="0 0 100 100"
        width={px}
        height={px}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Drop shadow under feet */}
        <ellipse cx={50} cy={92} rx={26} ry={4} fill="rgba(0,0,0,0.35)" />

        {/* Ears (behind body) */}
        {look.hasEars && (
          <>
            <ellipse cx={26} cy={28} rx={6} ry={10} fill={look.bodyColor} stroke="#0a0a14" strokeWidth={1.5} />
            <ellipse cx={74} cy={28} rx={6} ry={10} fill={look.bodyColor} stroke="#0a0a14" strokeWidth={1.5} />
          </>
        )}

        {/* Body */}
        {look.shape === 'circle' && (
          <circle cx={50} cy={55} r={32} fill={look.bodyColor} stroke="#0a0a14" strokeWidth={2.5} />
        )}
        {look.shape === 'oval' && (
          <ellipse cx={50} cy={55} rx={28} ry={34} fill={look.bodyColor} stroke="#0a0a14" strokeWidth={2.5} />
        )}
        {look.shape === 'pill' && (
          <rect x={20} y={26} width={60} height={60} rx={30} ry={30}
            fill={look.bodyColor} stroke="#0a0a14" strokeWidth={2.5} />
        )}

        {/* Belly */}
        <ellipse cx={50} cy={66} rx={18} ry={14} fill={look.bellyColor} opacity={0.9} />

        {/* Horn / hair tuft */}
        {look.hasHorn && (
          <path d="M 50 24 L 46 12 L 54 12 Z" fill={look.hairColor} stroke="#0a0a14" strokeWidth={1.5} />
        )}

        {/* Eyebrows */}
        {face.eyebrows === 'raised' && (
          <>
            <line x1={32} y1={42} x2={42} y2={39} stroke="#0a0a14" strokeWidth={2.5} strokeLinecap="round" />
            <line x1={58} y1={39} x2={68} y2={42} stroke="#0a0a14" strokeWidth={2.5} strokeLinecap="round" />
          </>
        )}
        {face.eyebrows === 'angry' && (
          <>
            <line x1={32} y1={40} x2={42} y2={44} stroke="#0a0a14" strokeWidth={2.5} strokeLinecap="round" />
            <line x1={58} y1={44} x2={68} y2={40} stroke="#0a0a14" strokeWidth={2.5} strokeLinecap="round" />
          </>
        )}
        {face.eyebrows === 'flat' && (
          <>
            <line x1={32} y1={42} x2={42} y2={42} stroke="#0a0a14" strokeWidth={2.5} strokeLinecap="round" />
            <line x1={58} y1={42} x2={68} y2={42} stroke="#0a0a14" strokeWidth={2.5} strokeLinecap="round" />
          </>
        )}

        {/* Eyes */}
        {face.eyeShape === 'open' && (
          <>
            <circle cx={38} cy={50} r={5} fill="#f6f0e0" stroke="#0a0a14" strokeWidth={2} />
            <circle cx={62} cy={50} r={5} fill="#f6f0e0" stroke="#0a0a14" strokeWidth={2} />
            <circle cx={39} cy={50} r={2.2} fill="#0a0a14" />
            <circle cx={63} cy={50} r={2.2} fill="#0a0a14" />
          </>
        )}
        {face.eyeShape === 'wide' && (
          <>
            <circle cx={38} cy={50} r={6.5} fill="#f6f0e0" stroke="#0a0a14" strokeWidth={2} />
            <circle cx={62} cy={50} r={6.5} fill="#f6f0e0" stroke="#0a0a14" strokeWidth={2} />
            <circle cx={38} cy={50} r={3} fill="#0a0a14" />
            <circle cx={62} cy={50} r={3} fill="#0a0a14" />
            <circle cx={36.5} cy={48.5} r={1} fill="#fff" />
            <circle cx={60.5} cy={48.5} r={1} fill="#fff" />
          </>
        )}
        {face.eyeShape === 'closed' && (
          <>
            <path d="M 33 50 Q 38 53 43 50" stroke="#0a0a14" strokeWidth={2.5} fill="none" strokeLinecap="round" />
            <path d="M 57 50 Q 62 53 67 50" stroke="#0a0a14" strokeWidth={2.5} fill="none" strokeLinecap="round" />
          </>
        )}
        {face.eyeShape === 'tilt' && (
          <>
            <ellipse cx={38} cy={50} rx={4} ry={2.5} fill="#0a0a14" />
            <ellipse cx={62} cy={50} rx={4} ry={2.5} fill="#0a0a14" />
          </>
        )}

        {/* Cheeks */}
        {face.cheeks && (
          <>
            <ellipse cx={28} cy={59} rx={3.5} ry={2.5} fill="rgba(255,90,120,0.5)" />
            <ellipse cx={72} cy={59} rx={3.5} ry={2.5} fill="rgba(255,90,120,0.5)" />
          </>
        )}

        {/* Mouth */}
        {face.mouth === 'smile' && (
          <path d="M 40 64 Q 50 73 60 64" stroke="#0a0a14" strokeWidth={2.5} fill="none" strokeLinecap="round" />
        )}
        {face.mouth === 'neutral' && (
          <line x1={43} y1={66} x2={57} y2={66} stroke="#0a0a14" strokeWidth={2.5} strokeLinecap="round" />
        )}
        {face.mouth === 'flat' && (
          <line x1={45} y1={66} x2={55} y2={66} stroke="#0a0a14" strokeWidth={2} strokeLinecap="round" />
        )}
        {face.mouth === 'O' && (
          <ellipse cx={50} cy={66} rx={4.5} ry={5} fill="#0a0a14" />
        )}
        {face.mouth === 'tongue' && (
          <>
            <path d="M 40 64 Q 50 73 60 64" stroke="#0a0a14" strokeWidth={2.5} fill="#0a0a14" />
            <ellipse cx={50} cy={70} rx={4} ry={3} fill="#ff7a8a" />
          </>
        )}

        {/* Sleep Z's */}
        {face.zzz && (
          <text x={78} y={28} fontSize={14} fontFamily="var(--font-pixel), monospace" fill="#f6f0e0" stroke="#0a0a14" strokeWidth={0.6}>z</text>
        )}
      </svg>

      {/* Speech bubble */}
      {speech && (
        <div
          style={{
            position: 'absolute',
            bottom: `${px - 8}px`,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--color-bg-dark)',
            color: 'var(--color-text)',
            border: '2px solid var(--color-border)',
            boxShadow: 'var(--shadow-pixel)',
            padding: '4px 8px',
            fontSize: '13px',
            fontFamily: 'var(--font-pixel)',
            whiteSpace: 'nowrap',
            maxWidth: '180px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {speech}
        </div>
      )}
    </div>
  );
}
