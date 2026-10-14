# TAM Command Center

Personal Technical Account Manager workspace (not a sales CRM). Browser UI served from a local Windows app; developed and tested on localhost.

- Spec (authoritative): `docs/SPEC.md`
- Build process and locked decisions: `docs/TEAM_LOOP.md`. Follow it; act as the orchestrator for the agents in `.claude/agents/`.
- Code lives in `TAM_Command_Center/`. Keep `TAM_Command_Center/TAM_PROJECT_STATE.md` and `CHANGELOG.md` updated on every substantive change (spec section 50).
- Never commit or package a real database.

- To resume the project in any session: run `claude --agent team-lead-agent` (or ask Claude to act as the team lead), which reads `docs/HANDOFF.md` first.
- Rules: user approves UI mockups before any UI is built; no packaging without go-ahead; all agents Sonnet/medium effort; watch token usage.
