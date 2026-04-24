import type { UseFileTreeResult } from '../hooks/useFileTree';
import type { UseProjectsResult } from '../hooks/useProjects';
import { FileTree } from './FileTree';
import { ProjectList } from './ProjectList';

interface Props {
  projects: UseProjectsResult;
  fileTree: UseFileTreeResult;
}

export function Sidebar({ projects, fileTree }: Props): React.JSX.Element {
  return (
    <div
      style={{
        width: '220px',
        minWidth: '180px',
        background: 'var(--color-bg)',
        borderRight: '2px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-pixel)',
      }}
    >
      <ProjectList
        projects={projects.projects}
        activeProjectId={projects.activeProjectId}
        onSwitch={(id) => void projects.switchProject(id)}
        onRemove={(id) => void projects.removeProject(id)}
        onOpenFolder={() => void projects.openAndAddProject()}
      />
      <div
        style={{
          height: '2px',
          background: 'var(--color-border)',
          margin: '0',
        }}
      />
      <FileTree tree={fileTree} />
    </div>
  );
}
