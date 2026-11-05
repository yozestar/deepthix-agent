"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isInlineTeammateOf = isInlineTeammateOf;
exports.getInlineTeammates = getInlineTeammates;
exports.hasInlineTeammates = hasInlineTeammates;
/**
 * Pure helpers for working with Lead + Teammates relationships.
 *
 * These replace the duplicated filter pattern
 *   `a.leadAgentId === agentId && !a.teamUsesTmux`
 *
 * "Inline teammate": a teammate running in-process with the lead (no separate
 * terminal). These share the lead's `session_id` in hook events, so routing
 * logic needs to redirect those events from the lead to the teammate.
 *
 * "Tmux teammate": a teammate running in a separate tmux pane with its own
 * `session_id`. Hooks route to it directly; no redirection needed.
 */
/** Is this agent an inline teammate (non-tmux) of the given lead? */
function isInlineTeammateOf(agent, leadId) {
    return agent.leadAgentId === leadId && !agent.teamUsesTmux;
}
/** All inline teammates of a lead. Returns [id, agent] pairs for convenience. */
function getInlineTeammates(leadId, agents) {
    const out = [];
    for (const [id, a] of agents) {
        if (isInlineTeammateOf(a, leadId))
            out.push([id, a]);
    }
    return out;
}
/** Does this lead have any active inline teammates? */
function hasInlineTeammates(leadId, agents) {
    for (const a of agents.values()) {
        if (isInlineTeammateOf(a, leadId))
            return true;
    }
    return false;
}
//# sourceMappingURL=teamUtils.js.map