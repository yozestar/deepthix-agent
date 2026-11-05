"use strict";
/**
 * Claude-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on Claude
 * unless Claude is the active provider.
 *
 * Adding another provider? Create its own `providers/<kind>/<name>/constants.ts`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLAUDE_HOOK_EVENTS = exports.CLAUDE_HOOK_SCRIPT_NAME = void 0;
/** Output filename after esbuild compiles claude-hook.ts to CJS (source is .ts, output is .js) */
exports.CLAUDE_HOOK_SCRIPT_NAME = 'claude-hook.js';
/** Hook events to install in ~/.claude/settings.json.
 *  SessionStart/SessionEnd handle session lifecycle (start, /clear, resume, exit).
 *  Stop/PermissionRequest/Notification handle turn completion and permission UI.
 *  SubagentStart/SubagentStop/TeammateIdle/TaskCreated/TaskCompleted power Agent Teams. */
exports.CLAUDE_HOOK_EVENTS = [
    'SessionStart',
    'SessionEnd',
    'Stop',
    'PermissionRequest',
    'Notification',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'SubagentStart',
    'SubagentStop',
    'TeammateIdle',
    'TaskCreated',
    'TaskCompleted',
];
//# sourceMappingURL=constants.js.map