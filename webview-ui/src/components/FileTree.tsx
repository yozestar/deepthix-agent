import type { FileTreeNode, UseFileTreeResult } from '../hooks/useFileTree';

interface Props {
  tree: UseFileTreeResult;
  /**
   * Optional click handler for file nodes (not directories). When provided,
   * clicking a non-dir node calls this callback. Used by the Files pane to
   * open a file as a sub-tab. The sidebar passes this too so a sidebar click
   * also opens the file in the Files pane (via App.tsx wiring).
   */
  onFileClick?: (path: string) => void;
  /**
   * Optional case-insensitive substring filter applied to the *path*. Tree is
   * walked depth-first; a directory survives the filter if any descendant
   * matches; a file survives if its path (case-insensitive) contains the
   * query. Empty string = no filter.
   */
  filter?: string;
  /**
   * If true, the header (FILES label + refresh button) is hidden. The Files
   * pane has its own header so we suppress this default one.
   */
  hideHeader?: boolean;
}

export function FileTree({
  tree,
  onFileClick,
  filter = '',
  hideHeader = false,
}: Props): React.JSX.Element {
  const { root, expanded, error, loading, toggle, refresh } = tree;
  const filterLower = filter.trim().toLowerCase();
  const filteredRoot = filterLower && root ? filterTree(root, filterLower) : root;

  return (
    <div
      style={{
        background: 'var(--color-bg)',
        padding: '8px',
        flex: 1,
        overflow: 'auto',
        fontFamily: 'var(--font-pixel)',
        fontSize: '0.8125rem',
      }}
    >
      {!hideHeader && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '0.75rem',
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
              fontSize: '0.75rem',
            }}
            aria-label="Refresh file tree"
            title="Refresh"
          >
            ⟳
          </button>
        </div>
      )}
      {error && <div style={{ color: 'var(--color-danger)', padding: '4px' }}>{error}</div>}
      {loading && !root && <div style={{ opacity: 0.6, padding: '4px' }}>Loading…</div>}
      {!loading && !root && <div style={{ opacity: 0.6, padding: '4px' }}>No project open.</div>}
      {filteredRoot && (
        <Branch
          node={filteredRoot}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          onFileClick={onFileClick}
          // Auto-expand nodes when filtering so matches are visible.
          forceExpanded={filterLower !== ''}
        />
      )}
      {filterLower && !filteredRoot && (
        <div style={{ opacity: 0.6, padding: '4px' }}>No matches.</div>
      )}
    </div>
  );
}

/**
 * Returns a copy of the tree with only nodes that match the filter (or have
 * descendants that match). Returns `null` when nothing matches. Pure: never
 * mutates the input.
 */
function filterTree(node: FileTreeNode, filterLower: string): FileTreeNode | null {
  const selfMatches = node.path.toLowerCase().includes(filterLower);
  if (!node.is_dir) {
    return selfMatches ? node : null;
  }
  // No children loaded yet → keep the dir if its own path matches (so the
  // user can expand it to drill in). Otherwise drop it.
  if (!node.children) {
    return selfMatches ? node : null;
  }
  const filteredChildren: FileTreeNode[] = [];
  for (const child of node.children) {
    const f = filterTree(child, filterLower);
    if (f) filteredChildren.push(f);
  }
  if (selfMatches || filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }
  return null;
}

function Branch({
  node,
  depth,
  expanded,
  onToggle,
  onFileClick,
  forceExpanded,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onFileClick?: (path: string) => void;
  forceExpanded: boolean;
}): React.JSX.Element {
  const isExpanded = forceExpanded || expanded.has(node.path);
  const isFile = !node.is_dir;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (node.is_dir) {
            onToggle(node.path);
          } else if (onFileClick) {
            console.debug('[Deepthix][FileTree] open file', node.path);
            onFileClick(node.path);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            if (node.is_dir) {
              onToggle(node.path);
            } else if (onFileClick) {
              onFileClick(node.path);
            }
          }
        }}
        style={{
          cursor: node.is_dir ? 'pointer' : isFile && onFileClick ? 'pointer' : 'default',
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
              onFileClick={onFileClick}
              forceExpanded={forceExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}
