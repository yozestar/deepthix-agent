/**
 * Background polls (session status, tab order, previews, live-session
 * lookup). On the desktop each poll is a free local call. On a remote
 * device every one is a round trip through Cloudflare + 4G, so there they
 * are spaced out, paused while the app is in the background, and run once
 * at once when the user comes back.
 */

import { REMOTE_POLL_FACTOR } from '../constants';
import { isRemoteRuntime } from '../runtime';

export interface PollEnv {
  remote: boolean;
  isHidden: () => boolean;
  /** Subscribe to "page visible again"; returns the unsubscribe. */
  onVisible: (cb: () => void) => () => void;
}

const browserEnv: PollEnv = {
  remote: isRemoteRuntime,
  isHidden: () => typeof document !== 'undefined' && document.hidden,
  onVisible: (cb) => {
    if (typeof document === 'undefined') return () => {};
    const handler = (): void => {
      if (!document.hidden) cb();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
};

/** Runs `fn` every `baseMs` (remote: spaced out, paused when hidden). */
export function startPolling(fn: () => void, baseMs: number, env: PollEnv = browserEnv): () => void {
  const interval = env.remote ? baseMs * REMOTE_POLL_FACTOR : baseMs;
  const id = setInterval(() => {
    if (env.remote && env.isHidden()) return;
    fn();
  }, interval);
  const offVisible = env.remote ? env.onVisible(fn) : () => {};
  return () => {
    clearInterval(id);
    offVisible();
  };
}
