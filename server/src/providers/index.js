"use strict";
/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add an export line below.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.copyHookScript = exports.claudeProvider = void 0;
var claude_js_1 = require("./hook/claude/claude.js");
Object.defineProperty(exports, "claudeProvider", { enumerable: true, get: function () { return claude_js_1.claudeProvider; } });
var claudeHookInstaller_js_1 = require("./hook/claude/claudeHookInstaller.js");
Object.defineProperty(exports, "copyHookScript", { enumerable: true, get: function () { return claudeHookInstaller_js_1.copyHookScript; } });
//# sourceMappingURL=index.js.map