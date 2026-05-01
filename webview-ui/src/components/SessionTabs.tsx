/* eslint-disable deepthix/no-inline-colors */
// Per-session tab strip: switches between the main Chat and the
// Coach (sub-session that analyses the main one). Keeps both panes
// MOUNTED at all times via display:none so streaming stays alive in
// the background — switching tabs doesn't tear down the chat session
// or clear the streaming bubble.

import { useState } from 'react';

import { ChatPane } from './ChatPane';
import { CoachPane } from './CoachPane';

interface Props {
  cwd: string;
  termId: string;
  /** Stable claude session UUID for the main session (null at spawn,
   *  filled in once the system/init event arrives). */
  sessionId: string | null;
  skipPermissions: boolean;
  onSessionReady: (info: { termId: string; sessionId: string | null }) => void;
}

type Tab = 'chat' | 'coach';

export function SessionTabs({
  cwd,
  termId,
  sessionId,
  skipPermissions,
  onSessionReady,
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('chat');
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <TabStrip tab={tab} onChange={setTab} />
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* Both panes are kept mounted; only the active one is visible
            so live streaming continues even when the user is reading
            the coach. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: tab === 'chat' ? 'flex' : 'none',
            flexDirection: 'column',
          }}
        >
          <ChatPane
            cwd={cwd}
            resumeSessionId={sessionId}
            skipPermissions={skipPermissions}
            bindTermId={termId}
            onSessionReady={onSessionReady}
          />
        </div>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: tab === 'coach' ? 'flex' : 'none',
            flexDirection: 'column',
          }}
        >
          <CoachPane cwd={cwd} mainSessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}

function TabStrip({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        background: 'var(--color-bg-dark)',
        borderBottom: '2px solid var(--color-border)',
      }}
    >
      <TabBtn label="Chat" active={tab === 'chat'} onClick={() => onChange('chat')} />
      <TabBtn label="Coach" active={tab === 'coach'} onClick={() => onChange('coach')} />
    </div>
  );
}

function TabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 14px',
        background: active ? 'var(--color-accent)' : 'transparent',
        color: active ? 'var(--color-bg-dark)' : 'inherit',
        border: 'none',
        borderRight: '2px solid var(--color-border)',
        cursor: 'pointer',
        fontFamily: 'var(--font-pixel)',
        fontSize: 11,
        letterSpacing: '0.05em',
      }}
    >
      {label}
    </button>
  );
}
