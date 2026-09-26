<!--
The always-in-context form of the delegating-vantik-work skill, for an agent
that reads no skills (a plain system prompt, an older runner). Paste the section
below into your repo's AGENTS.md or CLAUDE.md. Where your agent reads skills,
install the skill instead — `npx skills add https://your-vantik-host`, see
../README.md — since it loads on demand and keeps context free until delegation
actually comes up.
-->

## Delegating Vantik work

Vantik can work an issue itself in a hosted sandbox: `delegate_task` starts a
run, `list_agent_runs` says how it is going, and the result is a branch — a pull
request where a git host is connected. The run is judged against the issue's
**Definition of Done** and nothing else, so the issue is the brief.

**Delegate only an issue that is ready:** a Definition of Done a stranger could
check, one contained change, work the repository's own test, typecheck, lint
and build commands can verify, and no run already in flight — call
`list_agent_runs` first, and do not pass `force` to start a second beside a live
one. If the issue falls short, fix it first (`update_criteria` `add`,
`update_task`, `add_note`); that is cheaper than reviewing a confident diff
against imagined requirements.

A run implements, has Vantik run the repository's checks, is reviewed by a
second agent that cites a file and line for each finding, and revises, until the
reviewer accepts or the budget in **Settings → Agents** runs out. Out of budget,
it still delivers, as `NEEDS_REVIEW`. `SUCCEEDED` is reviewed and passing;
`FAILED` or `EXPIRED` carry a reason — fix that cause before running it again,
never re-run unchanged. Do not delegate an issue you are working yourself.
