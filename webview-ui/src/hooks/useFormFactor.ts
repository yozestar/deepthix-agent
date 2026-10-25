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

function current(): FormFactor {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  return classifyFormFactor(window.innerWidth, coarse);
}

export function useFormFactor(): FormFactor {
  const [ff, setFf] = useState<FormFactor>(current);

  useEffect(() => {
    const update = (): void => setFf(current());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // iOS: the on-screen keyboard shrinks the *visual* viewport only. Expose
  // its height so the root can shrink and keep the composer visible.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = (): void => root.style.setProperty('--app-height', `${vv.height}px`);
    apply();
    vv.addEventListener('resize', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      root.style.removeProperty('--app-height');
    };
  }, []);

  return ff;
}
