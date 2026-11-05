"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_HOOK_BODY_SIZE = exports.SESSION_END_GRACE_MS = exports.HOOK_EVENT_BUFFER_MS = exports.CLAUDE_HOOK_SCRIPT_NAME = exports.CLAUDE_HOOK_EVENTS = exports.HOOK_API_PREFIX = exports.HOOK_SCRIPTS_DIR = exports.SERVER_JSON_NAME = exports.SERVER_JSON_DIR = exports.TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = exports.BASH_COMMAND_DISPLAY_MAX_LENGTH = exports.GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = exports.GLOBAL_SCAN_ACTIVE_MIN_SIZE = exports.DISMISSED_COOLDOWN_MS = exports.EXTERNAL_STALE_CHECK_INTERVAL_MS = exports.EXTERNAL_ACTIVE_THRESHOLD_MS = exports.EXTERNAL_SCAN_INTERVAL_MS = exports.CLEAR_IDLE_THRESHOLD_MS = exports.TEXT_IDLE_DELAY_MS = exports.PERMISSION_TIMER_DELAY_MS = exports.TOOL_DONE_DELAY_MS = exports.PROJECT_SCAN_INTERVAL_MS = exports.FILE_WATCHER_POLL_INTERVAL_MS = exports.JSONL_POLL_INTERVAL_MS = void 0;
// ── JSONL File Watching ─────────────────────────────────────
exports.JSONL_POLL_INTERVAL_MS = 1000;
exports.FILE_WATCHER_POLL_INTERVAL_MS = 500;
exports.PROJECT_SCAN_INTERVAL_MS = 1000;
// ── Heuristic Agent Status Detection ────────────────────────
// These timers are the fallback when Claude Code Hooks are not
// active (hookDelivered = false). When hooks are working, these
// are suppressed and the server receives instant events instead.
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
exports.TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing permission bubble.
 *  Not used for teammates — false positives on slow tools (WebFetch/WebSearch).
 *  Teammates rely on the lead's routed Notification(permission_prompt) hook. */
exports.PERMISSION_TIMER_DELAY_MS = 7000;
/** Heuristic: silence duration before marking a text-only turn as complete */
exports.TEXT_IDLE_DELAY_MS = 5000;
/** Heuristic: idle threshold for per-agent /clear detection (content check prevents stealing) */
exports.CLEAR_IDLE_THRESHOLD_MS = 2000;
// ── External Session Detection ──────────────────────────────
exports.EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Only adopt JSONL files modified within this window */
exports.EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
/** Remove external agents after this much inactivity */
// export const EXTERNAL_STALE_TIMEOUT_MS = 300_000; // 5 minutes - deprecated
exports.EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** Cooldown after user closes an agent via X. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS
 *  so the file's mtime becomes stale before the dismissal expires. */
exports.DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes
// ── Global Session Scanning ─────────────────────────────────
/** Only adopt global JSONL files larger than this (filters out empty/init-only sessions) */
exports.GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global JSONL files modified within this window */
exports.GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes
// ── Display Truncation ──────────────────────────────────────
exports.BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
exports.TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;
// ── Pixel Agents Server ─────────────────────────────────────
exports.SERVER_JSON_DIR = '.pixel-agents';
exports.SERVER_JSON_NAME = 'server.json';
exports.HOOK_SCRIPTS_DIR = '.pixel-agents/hooks';
exports.HOOK_API_PREFIX = '/api/hooks';
// Claude-specific constants live in providers/hook/claude/constants.ts.
// Re-exported here for backward-compatibility of existing callers that import
// from '../server/src/constants.js'. New code should import directly from the provider.
var constants_js_1 = require("./providers/hook/claude/constants.js");
Object.defineProperty(exports, "CLAUDE_HOOK_EVENTS", { enumerable: true, get: function () { return constants_js_1.CLAUDE_HOOK_EVENTS; } });
Object.defineProperty(exports, "CLAUDE_HOOK_SCRIPT_NAME", { enumerable: true, get: function () { return constants_js_1.CLAUDE_HOOK_SCRIPT_NAME; } });
exports.HOOK_EVENT_BUFFER_MS = 5_000;
/** Grace period after SessionEnd(reason=clear/resume) before triggering onSessionEnd.
 *  /clear and /resume fire SessionEnd then SessionStart within ms. This timeout is a
 *  safety net: if SessionStart never arrives (e.g. Claude crashes mid-transition),
 *  the agent is cleaned up instead of staying as a zombie with pendingClear forever. */
exports.SESSION_END_GRACE_MS = 2000;
exports.MAX_HOOK_BODY_SIZE = 65_536; // 64KB
//# sourceMappingURL=constants.js.map