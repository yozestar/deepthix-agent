interface Props {
  onOpenFolder: () => void;
}

export function Welcome({ onOpenFolder }: Props): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '24px',
        background: 'var(--color-bg)',
        color: 'inherit',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      <div style={{ fontSize: '1.625rem', letterSpacing: '0.05em' }}>Deepthix Agent</div>
      <div style={{ fontSize: '0.875rem', opacity: 0.7, maxWidth: '320px', textAlign: 'center' }}>
        Open a folder to start your first project. Your agents will live in a pixel-art office,
        scoped to that project.
      </div>
      <button
        type="button"
        onClick={onOpenFolder}
        style={{
          padding: '12px 24px',
          fontSize: '1rem',
          background: 'var(--color-accent)',
          color: 'var(--color-bg-dark)',
          border: '2px solid var(--color-border)',
          boxShadow: 'var(--shadow-pixel)',
          cursor: 'pointer',
          fontFamily: 'var(--font-pixel)',
        }}
      >
        📂 Open Folder
      </button>
    </div>
  );
}
