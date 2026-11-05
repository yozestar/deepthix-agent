// "Going back to a project" (sidebar click, Ctrl+1…9) opens its most recent
// tab — the first one, tabs being sorted by last message. Only those entry
// points ask for it: opening a given conversation (search hit, task, session
// row) keeps the tab it chose. SessionTabs honours the request once the
// tab order of that project is known.

let pending: string | null = null;

export const MOST_RECENT_TAB_EVENT = 'elyone:most-recent-tab';

export function requestMostRecentTab(projectId: string): void {
  pending = projectId;
  // Clicking the project already shown changes no prop: wake SessionTabs.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MOST_RECENT_TAB_EVENT));
}

/** True once per request, for that project only. */
export function takeMostRecentTabRequest(projectId: string | null): boolean {
  if (!projectId || pending !== projectId) return false;
  pending = null;
  return true;
}
