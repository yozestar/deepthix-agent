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
        background: 'var(--pixel-bg)',
        color: 'inherit',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ fontSize: '24px', letterSpacing: '0.05em' }}>Deepthix Agent</div>
      <div style={{ fontSize: '12px', opacity: 0.7, maxWidth: '320px', textAlign: 'center' }}>
        Open a folder to start your first project. Your agents will live in a pixel-art office,
        scoped to that project.
      </div>
      <button
        type="button"
        onClick={onOpenFolder}
        style={{
          padding: '12px 24px',
          fontSize: '14px',
          background: 'var(--pixel-accent)',
          color: '#0a0a14',
          border: '2px solid var(--pixel-border)',
          boxShadow: '4px 4px 0 #0a0a14',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        📂 Open Folder
      </button>
    </div>
  );
}
