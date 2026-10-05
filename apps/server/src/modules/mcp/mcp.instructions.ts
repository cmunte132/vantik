/**
 * What every client that connects is told, before any tool is called.
 *
 * Clients that honour the MCP `instructions` field — Claude Code and Codex
 * among them — keep it in context for the whole session. That is what a skill
 * cannot do: a skill loads when the model decides the work looks like issue
 * work, which is usually after the silence it exists to prevent. So this is
 * the always-on minimum, and the skills are where the reasons live.
 *
 * Kept short because it is paid for on every turn of every session, used or
 * not. A rule belongs here only if an agent that never loads a skill should
 * still follow it.
 */
export const MCP_INSTRUCTIONS = `Vantik is this workspace's issue tracker and knowledge bank. Keep it current while you work, not afterwards:

- Before substantial work: search_tasks for its issue (file one first if there is none), get_task and read its Definition of Done, then pick_up_task before the first edit.
- As you work: update_criteria to tick each criterion the moment it is met, and add_note when the approach changes or you stop part-way. Never end a session with the issue out of date.
- When every criterion is met: close_task with a resolution. Do not send finished work to review. Your part done, but open criteria need a person to review or verify? update_task to the team's review state (for example "In Review") and add_note with what to review. When the person approves (in chat, a note, or a tick), close_task yourself. Blocked or stopped part-way? Leave it in progress and note what remains.
- File few, substantial issues. A step of existing work is a note or a sub-task, not a new issue; always search first.
- Before reading code in an area new to you: load_context with that area. Record what you learn with remember, one fact per call.

The hook_* tools (hook_session_start, hook_prompt_submit, hook_tool_use, hook_stop) are called by the hooks installed in your harness. Do not call them yourself.

The skills working-vantik-issues and working-vantik-knowledge hold the full guidance, where they are installed.`;
