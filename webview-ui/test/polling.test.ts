import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { REMOTE_POLL_FACTOR } from '../src/constants.ts';
import { type PollEnv, startPolling } from '../src/remote/polling.ts';

function env(remote: boolean) {
  let hidden = false;
  let visibleCb: (() => void) | null = null;
  const e: PollEnv = {
    remote,
    isHidden: () => hidden,
    onVisible: (cb) => {
      visibleCb = cb;
      return () => {
        visibleCb = null;
      };
    },
  };
  return {
    e,
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
      visibleCb?.();
    },
  };
}

test('desktop keeps the original interval and never pauses', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { e, hide } = env(false);
  let n = 0;
  const stop = startPolling(() => n++, 1000, e);
  mock.timers.tick(3000);
  assert.equal(n, 3);
  hide();
  mock.timers.tick(2000);
  assert.equal(n, 5, 'still polling while hidden on desktop');
  stop();
  mock.timers.reset();
});

test('remote spaces polls by the remote factor', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { e } = env(true);
  let n = 0;
  const stop = startPolling(() => n++, 1000, e);
  mock.timers.tick(1000 * REMOTE_POLL_FACTOR * 3);
  assert.equal(n, 3);
  stop();
  mock.timers.reset();
});

test('remote pauses while hidden and polls at once when visible again', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { e, hide, show } = env(true);
  let n = 0;
  const stop = startPolling(() => n++, 1000, e);
  hide();
  mock.timers.tick(1000 * REMOTE_POLL_FACTOR * 5);
  assert.equal(n, 0, 'no poll while the app is in the background');
  show();
  assert.equal(n, 1, 'immediate refresh on return');
  stop();
  mock.timers.reset();
});

test('stop clears the timer and the visibility listener', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { e, hide, show } = env(true);
  let n = 0;
  const stop = startPolling(() => n++, 1000, e);
  stop();
  hide();
  show();
  mock.timers.tick(1000 * REMOTE_POLL_FACTOR * 3);
  assert.equal(n, 0);
  mock.timers.reset();
});
