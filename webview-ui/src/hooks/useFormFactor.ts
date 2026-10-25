/**
 * Screen class used to adapt the layout for touch devices (remote access
 * from the iPhone Duo: ~unfolded = tablet, folded = phone). Thresholds are
 * estimates until measured on the device — see constants.ts.
 */

import { useEffect, useState } from 'react';

import { PHONE_MAX_WIDTH_PX, TABLET_MAX_WIDTH_PX } from '../constants';

export type FormFactor = 'desktop' | 'tablet' | 'phone';

export function classifyFormFactor(width: number, coarsePointer: boolean): FormFactor {
  if (!coarsePointer || width >= TABLET_MAX_WIDTH_PX) return 'desktop';
  return width < PHONE_MAX_WIDTH_PX ? 'phone' : 'tablet';
}

const COARSE_QUERY = '(pointer: coarse)';
/** Root class enabling the touch-only CSS (index.css). Desktop never gets it. */
const TOUCH_CLASS = 'touch-layout';

function current(): FormFactor {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  return classifyFormFactor(window.innerWidth, coarse);
}

/** Current screen class; safe to call from any component. */
export function useFormFactor(): FormFactor {
  const [ff, setFf] = useState<FormFactor>(current);

  useEffect(() => {
    const update = (): void => setFf(current());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return ff;
}

/**
 * Touch only — call ONCE, from the app root. iOS opens the keyboard by
 * shrinking the *visual* viewport and scrolling the page to reveal the
 * field; a root sized to the visual viewport then gets scrolled out of sight
 * (black screen). Instead the root is pinned to the visible area: same
 * height, moved by its offset (CSS vars read by App + index.css).
 */
export function useTouchViewport(ff: FormFactor): void {
  const touch = ff !== 'desktop';
  useEffect(() => {
    const vv = window.visualViewport;
    if (!touch || !vv) return;
    const root = document.documentElement;
    root.classList.add(TOUCH_CLASS);
    const apply = (): void => {
      root.style.setProperty('--app-height', `${vv.height}px`);
      root.style.setProperty('--app-offset-top', `${vv.offsetTop}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.classList.remove(TOUCH_CLASS);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-offset-top');
    };
  }, [touch]);
}
