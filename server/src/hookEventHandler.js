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
exports.HookEventHandler = void 0;
// TODO(Standalone version): Replace vscode.Webview with MessageSender interface from core/src/messages.ts
// TODO(Standalone version): Move timerManager and types to server/src/ to eliminate cross-boundary imports
const path = __importStar(require("path"));
const timerManager_js_1 = require("../../src/timerManager.js");
const constants_js_1 = require("./constants.js");
const teamUtils_js_1 = require("./teamUtils.js");
const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';
class HookEventHandler {
    agents;
    waitingTimers;
    permissionTimers;
    getWebview;
    provider;
    watchAllSessionsRef;
    sessionToAgentId = new Map();
    bufferedEvents = [];
    bufferTimer = null;
    lifecycleCallbacks = {};
    /** Pending external sessions waiting for a confirmation event (Stop, Notification, etc.). */
    pendingExternalSessions = new Map();
    constructor(agents, waitingTimers, permissionTimers, getWebview, provider, watchAllSessionsRef) {
        this.agents = agents;
        this.waitingTimers = waitingTimers;
        this.permissionTimers = permissionTimers;
        this.getWebview = getWebview;
        this.provider = provider;
        this.watchAllSessionsRef = watchAllSessionsRef;
    }
    /** Merged set of tool names that spawn subagents (teammates + within-turn subagents
     *  when a team provider is attached, or the base HookProvider set otherwise). */
    getSubagentToolSet() {
        if (this.provider.team) {
            return new Set([
                ...this.provider.team.teammateSpawnTools,
                ...this.provider.team.withinTurnSubagentTools,
            ]);
        }
        return this.provider.subagentToolNames;
    }
    /** Check if a session is tracked (in workspace project dir, or Watch All Sessions ON). */
    isTrackedSession(transcriptPath, cwd) {
        if (this.watchAllSessionsRef?.current)
            return true;
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (!projectDir)
            return false;
        return [...this.agents.values()].some((a) => path.resolve(a.projectDir).toLowerCase() === path.resolve(projectDir).toLowerCase());
    }
    /** Set callbacks for session lifecycle events (SessionStart/SessionEnd). */
    setLifecycleCallbacks(callbacks) {
        this.lifecycleCallbacks = callbacks;
    }
    /** Register an agent for hook event routing. Flushes any buffered events for this session. */
    registerAgent(sessionId, agentId) {
        this.sessionToAgentId.set(sessionId, agentId);
        // Flush any buffered events for this session
        this.flushBufferedEvents(sessionId);
    }
    /** Remove an agent's session mapping (called on agent removal/terminal close). */
    unregisterAgent(sessionId) {
        this.sessionToAgentId.delete(sessionId);
    }
    /**
     * Process an incoming hook event. Looks up the agent by session_id,
     * falls back to auto-discovery scan, or buffers if agent not yet registered.
     * @param providerId - Provider that sent the event ('claude', 'codex', etc.)
     * @param event - The hook event payload from the CLI tool
     */
    handleEvent(_providerId, event) {
        // ── Provider normalization boundary ───────────────────────────────────────
        // All raw Claude-specific fields (tool_name, tool_input, agent_type, notification_type,
        // reason, source) are extracted by provider.normalizeHookEvent. Downstream dispatch
        // uses the normalized AgentEvent.kind. Raw `event.*` reads are still allowed in a few
        // places for provider-specific metadata that AgentEvent doesn't capture (transcript_path,
        // cwd for external-session adoption; agent_type for teammate routing).
        const normalized = this.provider.normalizeHookEvent(event);
        if (!normalized)
            return; // unknown / uninteresting event -- silently drop
        const normEvent = normalized.event;
        const eventName = event.hook_event_name; // retained for logs only
        // --- SessionStart: handle /clear for known agents, ignore unknown sessions ---
        // External session detection via SessionStart is deferred to Phase C.
        // For now, only use SessionStart for:
        //   1. Confirming known agents (set hookDelivered)
        //   2. /clear reassignment (source=clear + pendingClear agent)
        if (normEvent.kind === 'sessionStart') {
            const sid = event.session_id.slice(0, 8);
            const source = normEvent.source ?? 'unknown';
            // transcript_path and cwd are not yet on the normalized sessionStart event;
            // provider carries them in the raw payload until they're promoted.
            const transcriptPath = event.transcript_path;
            const cwd = event.cwd;
            const tracked = this.isTrackedSession(transcriptPath, cwd);
            if (debug && tracked)
                console.log(`[Pixel Agents] Hook: SessionStart(source=${source}, session=${sid}...)`);
            // Check registered mapping
            const existingAgentId = this.sessionToAgentId.get(event.session_id);
            if (existingAgentId !== undefined) {
                const agent = this.agents.get(existingAgentId);
                if (agent) {
                    agent.hookDelivered = true;
                }
                if (debug)
                    console.log(`[Pixel Agents] Hook: Agent ${existingAgentId} - SessionStart(source=${source}) known`);
                return;
            }
            // Check auto-discovery (agent exists but not yet registered for hooks)
            for (const [id, agent] of this.agents) {
                if (agent.sessionId === event.session_id) {
                    this.registerAgent(agent.sessionId, id);
                    agent.hookDelivered = true;
                    if (debug)
                        console.log(`[Pixel Agents] Hook: Agent ${id} - SessionStart(source=${source}) auto-discovered`);
                    return;
                }
            }
            // /clear or /resume: reassign existing agent to new session
            if (normEvent.source === 'clear' || normEvent.source === 'resume') {
                const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
                if (projectDir) {
                    for (const [id, agent] of this.agents) {
                        // Both /clear and /resume send SessionEnd first (sets pendingClear),
                        // then SessionStart. Match the agent that has pendingClear in same project dir.
                        // Normalize paths for cross-platform comparison (separators + case-insensitive
                        // for Windows where drive letter casing differs: c:\ vs C:\).
                        const isMatch = agent.pendingClear &&
                            path.resolve(agent.projectDir).toLowerCase() ===
                                path.resolve(projectDir).toLowerCase();
                        if (isMatch) {
                            agent.pendingClear = false;
                            console.log(`[Pixel Agents] Hook: Agent ${id} - /${normEvent.source} detected, reassigning to ${event.session_id}`);
                            this.sessionToAgentId.delete(agent.sessionId);
                            this.registerAgent(event.session_id, id);
                            this.lifecycleCallbacks.onSessionClear?.(id, event.session_id, transcriptPath);
                            return;
                        }
                    }
                }
            }
            // Unknown session -- store as pending, create only when a confirmation event
            // arrives (Stop, Notification, PermissionRequest). This filters transient sessions
            // from Claude Code Extension which fire SessionStart + SessionEnd without any activity.
            if (transcriptPath || cwd) {
                // For --resume, clear dismissals so the file can be re-adopted
                if (normEvent.source === 'resume' && transcriptPath) {
                    this.lifecycleCallbacks.onSessionResume?.(transcriptPath);
                }
                if (debug && tracked)
                    console.log(`[Pixel Agents] Hook: SessionStart(source=${source}) -> pending external session ${sid}..., awaiting confirmation`);
                this.pendingExternalSessions.set(event.session_id, {
                    sessionId: event.session_id,
                    transcriptPath,
                    cwd: cwd ?? '',
                });
            }
            else {
                if (debug && tracked)
                    console.log(`[Pixel Agents] Hook: SessionStart -> unknown session ${sid}..., no transcript_path`);
            }
            return;
        }
        // --- All other events: standard agent lookup ---
        // If SessionEnd arrives for a pending external session, discard it (transient session)
        if (normEvent.kind === 'sessionEnd' && this.pendingExternalSessions.has(event.session_id)) {
            this.pendingExternalSessions.delete(event.session_id);
            if (debug)
                console.log(`[Pixel Agents] Hook: SessionEnd discarded pending external session ${event.session_id.slice(0, 8)}...`);
            return;
        }
        // If a confirmation event arrives for a pending external session, create the agent first
        if (this.pendingExternalSessions.has(event.session_id)) {
            const pending = this.pendingExternalSessions.get(event.session_id);
            this.pendingExternalSessions.delete(event.session_id);
            if (debug)
                console.log(`[Pixel Agents] Hook: ${eventName} confirmed external session ${event.session_id.slice(0, 8)}..., creating agent`);
            this.lifecycleCallbacks.onExternalSessionDetected?.(pending.sessionId, pending.transcriptPath, pending.cwd);
            // Re-process this event now that the agent exists
            this.handleEvent(_providerId, event);
            return;
        }
        let agentId = this.sessionToAgentId.get(event.session_id);
        if (agentId === undefined) {
            for (const [id, agent] of this.agents) {
                if (agent.sessionId === event.session_id) {
                    this.registerAgent(agent.sessionId, id);
                    agentId = id;
                    break;
                }
            }
        }
        if (agentId === undefined) {
            // Buffer if: pending external session, already buffering for this session,
            // OR agents exist that haven't been registered yet (internal agent race:
            // hook event arrives before registerAgent is called after launchNewTerminal).
            // Silently drop events for sessions we have no record of
            // (e.g. other projects with Watch All OFF).
            const isPending = this.pendingExternalSessions.has(event.session_id);
            const hasBuffered = this.bufferedEvents.some((b) => b.event.session_id === event.session_id);
            const hasUnregisteredAgents = [...this.agents.values()].some((a) => a.sessionId && !this.sessionToAgentId.has(a.sessionId));
            if (isPending || hasBuffered || hasUnregisteredAgents) {
                if (debug)
                    console.log(`[Pixel Agents] Hook: ${eventName} - unknown session ${event.session_id.slice(0, 8)}..., buffering`);
                this.bufferEvent(_providerId, event);
            }
            return;
        }
        const agent = this.agents.get(agentId);
        if (!agent)
            return;
        agent.hookDelivered = true;
        if (debug)
            console.log(`[Pixel Agents] Hook: Agent ${agentId} - ${eventName} (session=${event.session_id.slice(0, 8)}...)`);
        const webview = this.getWebview();
        // Dispatch on normalized AgentEvent.kind, not raw hook event names.
        // The TeammateIdle / TaskCompleted hooks normalize to `subagentTurnEnd` -- both
        // carry `agent_type` in the raw payload, which we pass to the team-routing handler.
        switch (normEvent.kind) {
            case 'sessionEnd':
                return this.handleSessionEnd(normEvent, agent, agentId, webview);
            case 'toolStart':
                return this.handlePreToolUse(normEvent, agent, agentId, webview);
            case 'toolEnd':
                // Both PostToolUse and PostToolUseFailure normalize to toolEnd. Distinguishing
                // them inside handlers would require extra info; the existing behavior was
                // identical for both (agentToolDone + clear currentHookToolId), so one branch suffices.
                return this.handlePostToolUse(agent, agentId, webview);
            case 'subagentStart':
                return this.provider.team
                    ? this.handleSubagentStart(event, agent, agentId, webview)
                    : undefined;
            case 'subagentEnd':
                return this.provider.team ? this.handleSubagentStop(agent, agentId, webview) : undefined;
            case 'permissionRequest':
                // Handles BOTH the PermissionRequest hook AND the Notification(permission_prompt)
                // hook -- normalizeHookEvent collapses them into one event kind.
                return this.handlePermissionRequest(agent, agentId, webview);
            case 'turnEnd':
                // Handles Stop AND Notification(idle_prompt) -- both normalize to turnEnd.
                return this.handleStop(agent, agentId, webview);
            case 'subagentTurnEnd':
                // Handles TeammateIdle AND TaskCompleted -- both normalize here. The team-
                // provider's extractTeammateNameFromEvent(raw) routes to the specific teammate.
                // (TaskCreated would have normalized to null already in the provider.)
                if (!this.provider.team)
                    return;
                if (eventName === 'TaskCompleted') {
                    return this.handleTaskCompleted(event, agentId);
                }
                return this.handleTeammateIdle(event, agent, agentId, webview);
            case 'userTurn':
            case 'progress':
                // Not yet consumed by the office visualization. Silently drop.
                return;
        }
    }
    /**
     * Handle SessionEnd: /clear marks pendingClear (SessionStart follows),
     * exit/logout marks agent waiting or triggers cleanup.
     */
    handleSessionEnd(normEvent, agent, agentId, webview) {
        const reason = normEvent.reason;
        if (debug)
            console.log(`[Pixel Agents] Hook: Agent ${agentId} - SessionEnd(reason=${reason ?? 'unknown'})`);
        // /clear and /resume send SessionEnd then SessionStart. Wait briefly for the follow-up.
        // All other reasons (exit, logout, prompt_input_exit) are final -- despawn immediately.
        const expectsFollowUp = reason === 'clear' || reason === 'resume';
        if (expectsFollowUp) {
            agent.pendingClear = true;
            this.markAgentWaiting(agent, agentId, webview);
            if (debug)
                console.log(`[Pixel Agents] Hook: Agent ${agentId} - SessionEnd(reason=${reason}), awaiting possible SessionStart`);
            // Safety net: if SessionStart never arrives, clean up the zombie agent
            setTimeout(() => {
                if (agent.pendingClear) {
                    agent.pendingClear = false;
                    this.lifecycleCallbacks.onSessionEnd?.(agentId, reason);
                }
            }, constants_js_1.SESSION_END_GRACE_MS);
        }
        else {
            // Immediate cleanup for exit/logout. onSessionEnd → removeTeammates in the
            // ViewProvider cleans up all teammates of this lead at once.
            this.markAgentWaiting(agent, agentId, webview);
            this.lifecycleCallbacks.onSessionEnd?.(agentId, reason ?? 'unknown');
        }
    }
    /**
     * Handle PreToolUse: instantly mark agent as active (cancel waiting state).
     * JSONL still handles detailed tool tracking (toolId, status text, webview messages).
     * This just ensures the character starts animating without waiting for the 500ms JSONL poll.
     */
    handlePreToolUse(normEvent, agent, agentId, webview) {
        const toolName = normEvent.toolName;
        const toolInput = normEvent.input ?? {};
        const status = this.provider.formatToolStatus(toolName, toolInput);
        const hookToolId = `hook-${Date.now()}`;
        // Track for PostToolUse/SubagentStart correlation (always, even if suppressed below).
        // currentHookIsTeammateSpawn is the authoritative teammate-vs-subagent discriminator.
        // It is NOT cleared in PostToolUse to survive the PostToolUse-before-SubagentStart race.
        agent.currentHookToolId = hookToolId;
        agent.currentHookToolName = toolName;
        agent.currentHookIsTeammateSpawn =
            this.provider.team?.isTeammateSpawnCall(toolName, toolInput) ?? false;
        // When a lead has inline teammates, hook tool events are ambiguous (could be
        // from the lead or any teammate -- they share session_id). Suppress hook-originated
        // tool display on the lead. Both lead and teammate tools display via JSONL polling.
        if ((0, teamUtils_js_1.hasInlineTeammates)(agentId, this.agents))
            return;
        // Cancel waiting, mark active
        (0, timerManager_js_1.cancelWaitingTimer)(agentId, this.waitingTimers);
        agent.isWaiting = false;
        agent.permissionSent = false;
        agent.hadToolsInTurn = true;
        // Send tool start + active state to webview (instant, no 500ms JSONL delay).
        // Skip for Task/Agent tools — their sub-agent characters need the stable JSONL
        // tool ID (not the transient hook ID) so that SubagentStop/tool_result cleanup
        // can find and remove them. JSONL handles agentToolStart (with runInBackground)
        // for these tools.
        if (toolName !== 'Task' && toolName !== 'Agent') {
            webview?.postMessage({
                type: 'agentToolStart',
                id: agentId,
                toolId: hookToolId,
                status,
                toolName,
            });
        }
        webview?.postMessage({
            type: 'agentStatus',
            id: agentId,
            status: 'active',
        });
    }
    /**
     * Handle PostToolUse: no action needed. JSONL handles tool_result processing.
     * Stop hook handles the idle transition. This is here for completeness and
     * to serve as a confirmation event for pending external sessions.
     */
    handlePostToolUse(agent, agentId, webview) {
        if (agent.currentHookToolId) {
            // Suppress tool display when lead has inline teammates (see handlePreToolUse)
            if (!(0, teamUtils_js_1.hasInlineTeammates)(agentId, this.agents)) {
                webview?.postMessage({
                    type: 'agentToolDone',
                    id: agentId,
                    toolId: agent.currentHookToolId,
                });
            }
            agent.currentHookToolId = undefined;
            agent.currentHookToolName = undefined;
        }
    }
    // NOTE: PostToolUseFailure used to have its own handler. The behavior was identical
    // to PostToolUse (emit agentToolDone, clear currentHookToolId). Both now normalize to
    // the 'toolEnd' AgentEvent kind and share handlePostToolUse.
    /**
     * Handle SubagentStart: notify webview that a sub-agent is spawning.
     *
     * For Agent Teams teammates (Agent tool with run_in_background), triggers
     * teammate discovery via lifecycle callback -- teammates become independent
     * agents with their own JSONL file watching.
     *
     * For old-style Task/Agent subagents (inline, no run_in_background), creates
     * the child character immediately via hooks without waiting for JSONL polling.
     */
    handleSubagentStart(event, agent, agentId, webview) {
        const agentType = this.provider.team?.extractTeammateNameFromEvent(event) ?? 'unknown';
        // Decide path: teammate spawn vs basic within-turn subagent.
        // Two conditions must BOTH hold for the teammate path:
        //   1. currentHookIsTeammateSpawn === true -- this specific tool call has the
        //      teammate-spawn flag (e.g. Agent with run_in_background=true)
        //   2. agent.teamName set -- JSONL has confirmed this agent is a team lead.
        //      Without this guard, external sessions firing run_in_background=true
        //      for parallel basic subagents would be mis-routed to teammate discovery.
        // Mirrors the same gate used by the periodic scanAllTeammateFiles fallback.
        if (this.provider.team && agent.currentHookIsTeammateSpawn === true && agent.teamName) {
            if (debug)
                console.log(`[Pixel Agents] Hook: Agent ${agentId} - SubagentStart: teammate "${agentType}" detected, triggering discovery`);
            this.lifecycleCallbacks.onTeammateDetected?.(agentId, event.session_id, agentType);
            return;
        }
        // Basic within-turn subagent path: find parent tool ID from activeToolNames.
        // Use only the real JSONL-populated id -- no synthetic fallback here, or we'd
        // double-track parents once JSONL catches up.
        const parentTools = this.getSubagentToolSet();
        let parentToolId;
        for (const [toolId, toolName] of agent.activeToolNames) {
            if (parentTools.has(toolName)) {
                parentToolId = toolId;
                break;
            }
        }
        if (!parentToolId)
            return; // JSONL will handle it via agent_progress tool_use
        // Create child sub-agent character immediately (same as old behavior).
        const subToolId = `hook-sub-${agentType}-${Date.now()}`;
        const status = `Subtask: ${agentType}`;
        // Track sub-agent
        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
            subTools = new Set();
            agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(subToolId);
        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
            subNames = new Map();
            agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(subToolId, agentType);
        webview?.postMessage({
            type: 'subagentToolStart',
            id: agentId,
            parentToolId,
            toolId: subToolId,
            status,
        });
    }
    /**
     * Handle SubagentStop: notify webview that a sub-agent finished.
     *
     * For Agent Teams teammates: marks all teammate agents as waiting (they're
     * independent agents, not sub-agent characters to destroy).
     *
     * For old-style Task subagents: removes the child character from the office.
     */
    handleSubagentStop(agent, agentId, webview) {
        // Check if this agent has inline teammates (independent agents with leadAgentId).
        // Just mark them waiting -- SubagentStop fires per-task-iteration; teammates may
        // sit idle for minutes between lead requests before being re-invoked.
        // Actual removal is driven by:
        //   - Periodic team config polling (scanTeamConfigsForRemovals) -- teammate
        //     removed when no longer in team config members list
        //   - SessionEnd on lead (removeTeammates in ViewProvider)
        const inlineTeammates = (0, teamUtils_js_1.getInlineTeammates)(agentId, this.agents);
        if (inlineTeammates.length > 0) {
            if (debug)
                console.log(`[Pixel Agents] Hook: Agent ${agentId} - SubagentStop: marking inline teammates as waiting`);
            for (const [id, a] of inlineTeammates) {
                this.markAgentWaiting(a, id, webview);
            }
            return;
        }
        // Old-style within-turn subagents: find a parent tool that actually has tracked
        // sub-agents. The `activeSubagentToolIds.has(toolId)` gate below prevents us
        // from picking a subagent-spawning parent that already had its sub-agents
        // cleared in the same turn.
        const subagentParentTools = this.getSubagentToolSet();
        let parentToolId;
        for (const [toolId, toolName] of agent.activeToolNames) {
            if (subagentParentTools.has(toolName) && agent.activeSubagentToolIds.has(toolId)) {
                parentToolId = toolId;
                break;
            }
        }
        if (!parentToolId)
            return; // JSONL will handle it via agent_progress tool_result
        agent.activeSubagentToolIds.delete(parentToolId);
        agent.activeSubagentToolNames.delete(parentToolId);
        webview?.postMessage({
            type: 'subagentClear',
            id: agentId,
            parentToolId,
        });
    }
    /** Handle PermissionRequest: cancel heuristic timer, show permission bubble on agent + sub-agents. */
    handlePermissionRequest(agent, agentId, webview) {
        // When lead has inline teammates, route permission to the teammates instead.
        // The hook fires on the lead's session_id but the permission is for a teammate.
        const inlineTeammates = (0, teamUtils_js_1.getInlineTeammates)(agentId, this.agents);
        if (inlineTeammates.length > 0) {
            for (const [id, a] of inlineTeammates) {
                (0, timerManager_js_1.cancelPermissionTimer)(id, this.permissionTimers);
                a.permissionSent = true;
                webview?.postMessage({ type: 'agentToolPermission', id });
            }
            return;
        }
        (0, timerManager_js_1.cancelPermissionTimer)(agentId, this.permissionTimers);
        agent.permissionSent = true;
        webview?.postMessage({
            type: 'agentToolPermission',
            id: agentId,
        });
        // Also notify any sub-agents with active tools
        for (const parentToolId of agent.activeSubagentToolNames.keys()) {
            webview?.postMessage({
                type: 'subagentToolPermission',
                id: agentId,
                parentToolId,
            });
        }
    }
    /** Handle Stop: Claude finished responding, mark agent as waiting. */
    handleStop(agent, agentId, webview) {
        this.markAgentWaiting(agent, agentId, webview);
    }
    /**
     * Handle TeammateIdle: teammate signaled it's idle and available for work.
     * Routes to the specific teammate if identifiable by agent_type, otherwise
     * marks all inline teammates of this lead as waiting.
     * Fallback: if the agent has no inline teammates, mark the agent itself.
     */
    handleTeammateIdle(event, agent, agentId, webview) {
        const agentType = this.provider.team?.extractTeammateNameFromEvent(event);
        const inlineTeammates = (0, teamUtils_js_1.getInlineTeammates)(agentId, this.agents);
        if (inlineTeammates.length === 0) {
            // No inline teammates — treat as a regular idle signal for this agent
            this.markAgentWaiting(agent, agentId, webview);
            return;
        }
        // Match by agentName if provider extracted a name from the event
        if (agentType) {
            const match = inlineTeammates.find(([, a]) => a.agentName === agentType);
            if (match) {
                const [id, a] = match;
                if (debug)
                    console.log(`[Pixel Agents] Hook: TeammateIdle "${agentType}" -> teammate Agent ${id}`);
                this.markAgentWaiting(a, id, webview);
                return;
            }
        }
        // Fallback: mark all inline teammates as waiting
        if (debug)
            console.log(`[Pixel Agents] Hook: TeammateIdle (no agent_type match) -> marking ${inlineTeammates.length} teammate(s) waiting`);
        for (const [id, a] of inlineTeammates) {
            this.markAgentWaiting(a, id, webview);
        }
    }
    /**
     * Handle TaskCompleted: a teammate marked its task done.
     * Routes to the specific teammate when identifiable, marking it waiting instantly.
     */
    handleTaskCompleted(event, agentId) {
        const subject = event.subject ?? '';
        const agentType = this.provider.team?.extractTeammateNameFromEvent(event);
        if (debug)
            console.log(`[Pixel Agents] Hook: Agent ${agentId} - TaskCompleted: ${subject}${agentType ? ` (agent_type=${agentType})` : ''}`);
        const inlineTeammates = (0, teamUtils_js_1.getInlineTeammates)(agentId, this.agents);
        if (inlineTeammates.length === 0)
            return;
        const webview = this.getWebview();
        // Match by agentName if available, otherwise mark all inline teammates waiting
        if (agentType) {
            const match = inlineTeammates.find(([, a]) => a.agentName === agentType);
            if (match) {
                const [id, a] = match;
                this.markAgentWaiting(a, id, webview);
                return;
            }
        }
        for (const [id, a] of inlineTeammates) {
            this.markAgentWaiting(a, id, webview);
        }
    }
    /**
     * Transition agent to waiting state. Clears foreground tools (preserves background
     * agents), cancels timers, and notifies the webview. Same logic as the turn_duration
     * handler in transcriptParser.ts.
     */
    markAgentWaiting(agent, agentId, webview) {
        (0, timerManager_js_1.cancelWaitingTimer)(agentId, this.waitingTimers);
        (0, timerManager_js_1.cancelPermissionTimer)(agentId, this.permissionTimers);
        // Clear foreground tools, preserve background agents (same logic as turn_duration handler).
        // ALWAYS send agentToolsClear at turn end -- even when activeToolIds is empty by now
        // (because tool_results already processed and removed them). Without this, stale
        // sub-agent characters and permission bubbles from the turn would never clear.
        const parentTools = this.getSubagentToolSet();
        for (const toolId of [...agent.activeToolIds]) {
            if (agent.backgroundAgentToolIds.has(toolId))
                continue;
            agent.activeToolIds.delete(toolId);
            agent.activeToolStatuses.delete(toolId);
            const toolName = agent.activeToolNames.get(toolId);
            agent.activeToolNames.delete(toolId);
            if (toolName && parentTools.has(toolName)) {
                agent.activeSubagentToolIds.delete(toolId);
                agent.activeSubagentToolNames.delete(toolId);
            }
        }
        webview?.postMessage({ type: 'agentToolsClear', id: agentId });
        // Re-send background agent tools to restore them after the clear
        for (const toolId of agent.backgroundAgentToolIds) {
            const status = agent.activeToolStatuses.get(toolId);
            if (status) {
                webview?.postMessage({
                    type: 'agentToolStart',
                    id: agentId,
                    toolId,
                    status,
                });
            }
        }
        agent.isWaiting = true;
        agent.permissionSent = false;
        agent.hadToolsInTurn = false;
        webview?.postMessage({
            type: 'agentStatus',
            id: agentId,
            status: 'waiting',
        });
    }
    /** Buffer an event for later delivery when the agent registers. */
    bufferEvent(providerId, event) {
        this.bufferedEvents.push({ providerId, event, timestamp: Date.now() });
        if (!this.bufferTimer) {
            this.bufferTimer = setInterval(() => {
                this.pruneExpiredBufferedEvents();
            }, constants_js_1.HOOK_EVENT_BUFFER_MS);
        }
    }
    /** Deliver all buffered events for a session that just registered. */
    flushBufferedEvents(sessionId) {
        const toFlush = this.bufferedEvents.filter((b) => b.event.session_id === sessionId);
        this.bufferedEvents = this.bufferedEvents.filter((b) => b.event.session_id !== sessionId);
        if (debug && toFlush.length > 0) {
            if (debug)
                console.log(`[Pixel Agents] Hook: flushing ${toFlush.length} buffered event(s) for session ${sessionId.slice(0, 8)}...`);
        }
        for (const { providerId, event } of toFlush) {
            this.handleEvent(providerId, event);
        }
        this.cleanupBufferTimer();
    }
    /** Remove buffered events older than HOOK_EVENT_BUFFER_MS. */
    pruneExpiredBufferedEvents() {
        const cutoff = Date.now() - constants_js_1.HOOK_EVENT_BUFFER_MS;
        this.bufferedEvents = this.bufferedEvents.filter((b) => b.timestamp > cutoff);
        this.cleanupBufferTimer();
    }
    /** Stop the prune interval when no buffered events remain. */
    cleanupBufferTimer() {
        if (this.bufferedEvents.length === 0 && this.bufferTimer) {
            clearInterval(this.bufferTimer);
            this.bufferTimer = null;
        }
    }
    /** Clean up timers and maps. Called when the extension disposes. */
    dispose() {
        if (this.bufferTimer) {
            clearInterval(this.bufferTimer);
            this.bufferTimer = null;
        }
        this.sessionToAgentId.clear();
        this.bufferedEvents = [];
        this.pendingExternalSessions.clear();
    }
}
exports.HookEventHandler = HookEventHandler;
//# sourceMappingURL=hookEventHandler.js.map