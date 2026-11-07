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
/** Room-saving mode while the on-screen keyboard is up (CSS: .dt-hide-when-keyboard). */
const KEYBOARD_CLASS = 'keyboard-open';
/** Visible height below this share of the tallest seen = keyboard up. */
const KEYBOARD_HEIGHT_RATIO = 0.8;

/**
 * Is the on-screen keyboard up? A text field has focus and the visible
 * height dropped well below the tallest height seen (iOS keeps
 * window.innerHeight unchanged, so compare with what we observed).
 */
export function keyboardOpen(visibleHeight: number, tallestSeen: number, editableFocused: boolean): boolean {
  return editableFocused && tallestSeen > 0 && visibleHeight < tallestSeen * KEYBOARD_HEIGHT_RATIO;
}

function editableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'file', 'range'].includes((el as HTMLInputElement).type);
}

export function useTouchViewport(ff: FormFactor): void {
  const touch = ff !== 'desktop';
  useEffect(() => {
    const vv = window.visualViewport;
    if (!touch || !vv) return;
    const root = document.documentElement;
    root.classList.add(TOUCH_CLASS);
    let tallest = vv.height;
    const apply = (): void => {
      root.style.setProperty('--app-height', `${vv.height}px`);
      root.style.setProperty('--app-offset-top', `${vv.offsetTop}px`);
      if (!editableFocused()) tallest = Math.max(tallest, vv.height);
      root.classList.toggle(KEYBOARD_CLASS, keyboardOpen(vv.height, tallest, editableFocused()));
    };
    // Rotation / fold: the full height changes, start over.
    const reset = (): void => {
      tallest = 0;
      window.setTimeout(apply, 300);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    document.addEventListener('focusin', apply);
    document.addEventListener('focusout', apply);
    window.addEventListener('orientationchange', reset);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.removeEventListener('focusin', apply);
      document.removeEventListener('focusout', apply);
      window.removeEventListener('orientationchange', reset);
      root.classList.remove(TOUCH_CLASS);
      root.classList.remove(KEYBOARD_CLASS);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-offset-top');
    };
  }, [touch]);
}
