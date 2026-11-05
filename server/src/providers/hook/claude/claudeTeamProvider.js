"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeTeamProvider = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/**
 * Claude Code implementation of the TeamProvider interface.
 *
 * Encapsulates every Claude-specific path, field name, and tool identifier
 * for the Agent Teams feature. Adding support for a new CLI means creating a
 * sibling file; no changes to hookEventHandler.ts or fileWatcher.ts.
 */
exports.claudeTeamProvider = {
    providerId: 'claude',
    teammateSpawnTools: new Set(['Agent']),
    withinTurnSubagentTools: new Set(['Task']),
    isTeammateSpawnCall(toolName, toolInput) {
        // Claude's Agent tool spawns a teammate ONLY when run_in_background is true.
        // Agent without that flag is a basic within-turn subagent (identical UX to Task).
        return toolName === 'Agent' && toolInput.run_in_background === true;
    },
    extractTeammateNameFromEvent(event) {
        const value = event.agent_type;
        return typeof value === 'string' ? value : undefined;
    },
    resolveTeammateMetadataPath(teammateJsonlFile) {
        return teammateJsonlFile.replace(/\.jsonl$/, '.meta.json');
    },
    parseTeammateMetadata(metadataContents) {
        try {
            const data = JSON.parse(metadataContents);
            return typeof data.agentType === 'string' ? data.agentType : null;
        }
        catch {
            return null;
        }
    },
    resolveTeammateJsonlDir(projectDir, leadSessionId) {
        return path.join(projectDir, leadSessionId, 'subagents');
    },
    getTeamMembers(teamName) {
        const configPath = path.join(os.homedir(), '.claude', 'teams', teamName, 'config.json');
        let raw;
        try {
            raw = fs.readFileSync(configPath, 'utf-8');
        }
        catch {
            return null; // config missing / unreadable -> team dissolved
        }
        try {
            const data = JSON.parse(raw);
            if (!Array.isArray(data.members))
                return null;
            const names = new Set();
            for (const m of data.members) {
                if (m && typeof m.name === 'string')
                    names.add(m.name);
            }
            return names;
        }
        catch {
            return null;
        }
    },
    extractTeamMetadataFromRecord(record) {
        const teamName = record.teamName;
        if (typeof teamName !== 'string')
            return null;
        const agentName = record.agentName;
        return {
            teamName,
            agentName: typeof agentName === 'string' ? agentName : undefined,
        };
    },
};
//# sourceMappingURL=claudeTeamProvider.js.map