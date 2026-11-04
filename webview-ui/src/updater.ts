// Auto-update helpers shared by the banner and Settings.

import { check, type Update } from '@tauri-apps/plugin-updater';

import { UPDATE_AUTH } from './constants';

/** Sent with the check AND the download (the plugin reuses check headers). */
const UPDATE_HEADERS = { Authorization: `Basic ${btoa(UPDATE_AUTH)}` };

/** Looks for a newer signed version on the update server (null: up to date). */
export function checkForUpdate(): Promise<Update | null> {
  return check({ headers: UPDATE_HEADERS, timeout: 30_000 });
}
