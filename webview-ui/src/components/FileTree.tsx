import type { FileTreeNode, UseFileTreeResult } from '../hooks/useFileTree';

interface Props {
  tree: UseFileTreeResult;
}

export function FileTree({ tree }: Props): React.JSX.Element {
  const { root, expanded, error, loading, toggle, refresh } = tree;

  return (
    <div
      style={{
        background: 'var(--color-bg)',
        padding: '8px',
        flex: 1,
        overflow: 'auto',
        fontFamily: 'var(--font-pixel)',
        fontSize: '13px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '12px',
          opacity: 0.7,
          letterSpacing: '0.1em',
          padding: '4px',
        }}
      >
        <span>FILES</span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || !root}
          style={{
            background: 'transparent',
            color: 'inherit',
            border: 'none',
            cursor: 'pointer',
            opacity: 0.6,
            padding: '0 4px',
            fontSize: '12px',
          }}
          aria-label="Refresh file tree"
          title="Refresh"
        >
          ⟳
        </button>
      </div>
      {error && (
        <div style={{ color: 'var(--color-danger)', padding: '4px' }}>
          {error}
        </div>
      )}
      {loading && !root && <div style={{ opacity: 0.6, padding: '4px' }}>Loading…</div>}
      {!loading && !root && (
        <div style={{ opacity: 0.6, padding: '4px' }}>No project open.</div>
      )}
      {root && <Branch node={root} depth={0} expanded={expanded} onToggle={toggle} />}
    </div>
  );
}

function Branch({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}): React.JSX.Element {
  const isExpanded = expanded.has(node.path);
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (node.is_dir) onToggle(node.path);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && node.is_dir) onToggle(node.path);
        }}
        style={{
          cursor: node.is_dir ? 'pointer' : 'default',
          opacity: node.is_hidden ? 0.55 : 1,
          padding: `2px 4px 2px ${4 + depth * 12}px`,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={node.path}
      >
        {node.is_dir ? (isExpanded ? '▾ ' : '▸ ') : '   '}
        {node.name}
        {node.loading && <span style={{ opacity: 0.5 }}> …</span>}
      </div>
      {node.is_dir && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <Branch
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
