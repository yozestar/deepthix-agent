"use strict";
/**
 * Provider abstraction for AI agent tools.
 *
 * Only HookProvider ships today (Claude Code). Transcript-polling and push-based
 * provider types will be added when a real second provider (Codex, Goose,
 * Discord, etc.) actually lands, derived from that provider's needs rather than
 * speculation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
// TODO(provider type taxonomy): FileProvider (polling-only CLIs) and StreamProvider
// (push-based external services) will be added alongside the first real second provider
//# sourceMappingURL=provider.js.map