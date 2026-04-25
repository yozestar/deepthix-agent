/* eslint-disable deepthix/no-inline-colors */
// SVG "brain" companion. Replaces the rolling ball look with a stylized brain
// silhouette — two hemispheres + gyri + a brain-stem stub. Body color is
// hashed from the seed so each project gets a stable look. When `active=true`
// (claude is using a tool) glowing synapses pulse along the gyri paths.

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface Look {
  fill: string;
  fillDeep: string;
  gyri: string;
  outline: string;
  pulse: string;
}

function makeLook(seed: string): Look {
  const h = hash(seed);
  const baseHue = h % 360;
  return {
    fill: `hsl(${baseHue}, 70%, 70%)`,
    fillDeep: `hsl(${baseHue}, 70%, 55%)`,
    gyri: `hsl(${baseHue}, 60%, 35%)`,
    outline: `hsl(${baseHue}, 70%, 22%)`,
    pulse: `hsl(${(baseHue + 180) % 360}, 95%, 65%)`,
  };
}

interface Props {
  /** Stable identifier — same value → same brain. */
  seed: string;
  /** Pixel size of the bounding box. Defaults to 96. */
  size?: number;
  /** True when claude is using a tool — triggers the synapse pulse. */
  active?: boolean;
}

export function PixelBrain({ seed, size, active }: Props): React.JSX.Element {
  const px = size ?? 96;
  const look = makeLook(seed);
  const filterId = `brain-glow-${hash(seed)}`;

  return (
    <div style={{ position: 'relative', width: px, height: px, display: 'inline-block' }}>
      <svg
        viewBox="0 0 100 100"
        width={px}
        height={px}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <defs>
          <filter id={filterId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
          <linearGradient id={`brain-grad-${hash(seed)}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={look.fill} />
            <stop offset="1" stopColor={look.fillDeep} />
          </linearGradient>
        </defs>

        {/* Drop shadow */}
        <ellipse cx={50} cy={92} rx={26} ry={4} fill="rgba(0,0,0,0.4)" />

        {/* Active glow under the brain */}
        {active && (
          <ellipse
            cx={50}
            cy={50}
            rx={42}
            ry={36}
            fill={look.pulse}
            opacity={0.45}
            filter={`url(#${filterId})`}
          >
            <animate attributeName="opacity" values="0.25;0.7;0.25" dur="1.4s" repeatCount="indefinite" />
          </ellipse>
        )}

        {/* Brain stem */}
        <path
          d="M 44 78 Q 44 88 50 90 Q 56 88 56 78 Z"
          fill={look.fillDeep}
          stroke={look.outline}
          strokeWidth={1.6}
        />

        {/* Left hemisphere */}
        <path
          d="M 50 22
             C 30 22 18 36 18 52
             C 18 70 30 80 48 80
             L 48 22
             Z"
          fill={`url(#brain-grad-${hash(seed)})`}
          stroke={look.outline}
          strokeWidth={2.2}
        />

        {/* Right hemisphere */}
        <path
          d="M 50 22
             C 70 22 82 36 82 52
             C 82 70 70 80 52 80
             L 52 22
             Z"
          fill={`url(#brain-grad-${hash(seed)})`}
          stroke={look.outline}
          strokeWidth={2.2}
        />

        {/* Central fissure */}
        <line
          x1={50}
          y1={22}
          x2={50}
          y2={78}
          stroke={look.outline}
          strokeWidth={2}
          strokeLinecap="round"
        />

        {/* Gyri (folds) — left hemisphere */}
        <path
          d="M 25 38 Q 33 42 30 50 Q 23 56 28 64"
          stroke={look.gyri}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 35 30 Q 42 36 38 44 Q 32 52 39 60 Q 45 66 40 74"
          stroke={look.gyri}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />

        {/* Gyri — right hemisphere */}
        <path
          d="M 75 38 Q 67 42 70 50 Q 77 56 72 64"
          stroke={look.gyri}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 65 30 Q 58 36 62 44 Q 68 52 61 60 Q 55 66 60 74"
          stroke={look.gyri}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />

        {/* Synapse dots — only animated when active */}
        {active && (
          <>
            <circle cx={28} cy={45} r={1.8} fill={look.pulse}>
              <animate attributeName="cx" values="28;38;32;28" dur="2.2s" repeatCount="indefinite" />
              <animate attributeName="cy" values="45;52;58;45" dur="2.2s" repeatCount="indefinite" />
              <animate attributeName="r" values="1.8;2.6;1.8" dur="0.7s" repeatCount="indefinite" />
            </circle>
            <circle cx={72} cy={45} r={1.8} fill={look.pulse}>
              <animate attributeName="cx" values="72;62;68;72" dur="2s" repeatCount="indefinite" />
              <animate attributeName="cy" values="45;52;58;45" dur="2s" repeatCount="indefinite" />
              <animate attributeName="r" values="1.8;2.4;1.8" dur="0.6s" repeatCount="indefinite" />
            </circle>
            <circle cx={50} cy={36} r={1.6} fill={look.pulse}>
              <animate attributeName="cy" values="36;72;36" dur="1.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.2;1;0.2" dur="1.8s" repeatCount="indefinite" />
            </circle>
            {/* Pulsing rings around the brain */}
            <circle
              cx={50}
              cy={48}
              r={32}
              fill="none"
              stroke={look.pulse}
              strokeWidth={1.5}
              opacity={0.6}
            >
              <animate attributeName="r" values="30;42;30" dur="1.6s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.7;0;0.7" dur="1.6s" repeatCount="indefinite" />
            </circle>
          </>
        )}

        {/* Idle state: gentle "breathing" eye-spots that look like simple thinking */}
        {!active && (
          <>
            <circle cx={36} cy={46} r={1.6} fill={look.outline}>
              <animate attributeName="opacity" values="1;0.3;1" dur="3s" repeatCount="indefinite" />
            </circle>
            <circle cx={64} cy={46} r={1.6} fill={look.outline}>
              <animate attributeName="opacity" values="1;0.3;1" dur="3s" repeatCount="indefinite" />
            </circle>
          </>
        )}
      </svg>
    </div>
  );
}
