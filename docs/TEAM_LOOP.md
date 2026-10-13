# TAM Command Center: Team Loop

The main Claude session is the **orchestrator**. Subagents cannot spawn each other, so the orchestrator invokes them in order, relays file paths (never summaries) between them, and enforces the gates. Handoffs happen through files in `docs/` so every decision is auditable.

## Locked decisions (2026-10-12)
| Topic | Decision |
|---|---|
| Stack | Python 3.10+ / FastAPI / SQLite; React + TypeScript + Vite compiled to static assets; Recharts; custom CSS tokens. No Tailwind or UI kit. No Node needed at runtime. |
| Auth / RAG | None. Single-user, loopback-only. ChatGPT Bridge (later phase) replaces RAG. |
| Packaging | Windows `.bat` launchers + release zip with SHA-256 manifest. No Docker/Terraform/Vercel. |
| Scope this run | Spec phases 1-2: foundation, Today, Accounts, Account Workspace, Quick Capture. Operations, BAMS, portability, and the ChatGPT Bridge come in later runs. |
| Source of truth | `docs/SPEC.md` |
| Code location | `TAM_Command_Center/` |

## Severity policy (updated 2026-10-12 at user request)
- **Blocker / High** (data loss, security hole, broken spec requirement, crash, wrong core behavior): must be fixed and re-verified by QA before a gate passes. These get the full strict loop.
- **Medium / Low** (hardening gaps, edge cases, polish, doc drift): do NOT block a gate. QA lists them with owner and they are tracked in `docs/qa/OPEN_ITEMS.md`; the owner fixes them in the next normal pass, and QA re-checks them at the next gate. A Medium becomes High if QA can show a concrete path to data loss or a security hole *in shipped code* (not a hypothetical future misuse).
- Why: Mediums and Lows cost a full fix-and-re-review round (about 10-25 min and a large token spend each) while changing little about whether the product works. Four schema rounds were spent on a scanner gap that the integration gate checks anyway against real code. Strictness is kept where a miss is expensive (High+).
- All agents run on Sonnet (user decision); escalate a specific task to Opus only if the user asks.

## Agents
`pm-agent` · `data-architect-agent` · `backend-dev-agent` · `frontend-dev-agent` · `qa-guardrail-agent` · `deployment-agent` (all in `.claude/agents/`).

## Mockup gate (added 2026-10-12 at user request) — HARD RULE
Before ANY UI is built for a phase or feature, the orchestrator must show the user mockups of exactly what will be built and wait for an explicit approval in chat. No frontend implementation, and no packaging/release, starts until then. Mockups are produced by frontend-dev-agent from the PM spec (static HTML/visual mockups, not the real app) and reviewed with the user. The same applies to every later phase (Operations, BAMS, Bulk Upload, ChatGPT Bridge). Packaging/release (phase 4.3) additionally needs the user's explicit go-ahead after they have seen the working app.

## Phase 1: Requirements & architecture
1. **1.1** pm-agent → `docs/01_PM_SPEC.md`, `docs/02_DESIGN_GUIDELINES.md`
2. **1.2** data-architect-agent → `db/schema.sql`, migrations, mock data, `docs/03_DATA_MODEL.md`
3. **1.3** qa-guardrail-agent → `docs/qa/SCHEMA_REVIEW_<n>.md`
   - `REJECTED` → back to 1.2 with the review as input. Repeat until `APPROVED`.

## Phase 2: Parallel build
4. **2.1** backend-dev-agent → API, tests, `docs/04_API_CONTRACT.md`
5. **2.2** frontend-dev-agent → UI + design system (launched in parallel with 2.1)
6. **2.3** frontend-dev-agent → wires components to mock JSON via the swappable adapter

## Phase 3: Integration & verification loop
7. **3.1** Orchestrator: confirm both trees build, commit a checkpoint (`git add -A && git commit`).
8. **3.2** qa-guardrail-agent → `docs/qa/ERROR_LOG_<n>.md`
9. **3.3** If `VERDICT: FAIL`: route each item to its owner agent (the log names the owner), then re-run 3.2 as `<n+1>`. **Repeat until `VERDICT: PASS (0 open Blocker/High)`.** Schema changes loop back through 1.2 → 1.3.

## Phase 4: Assembly & release
10. **4.1** backend-dev-agent: swap the frontend adapter target to the live API (frontend-dev-agent updates the adapter config); QA re-runs 3.2 on the result.
11. **4.2** pm-agent → `docs/05_TRACEABILITY.md`. Any non-PASS item routes back to its owner, then returns to Phase 3.
12. **4.3** deployment-agent → release archive, launchers, manifest, `VALIDATION.txt`.

## Loop termination
The run is complete only when: QA verdict is `PASS (0 open Blocker/High)` **and** the PM traceability matrix has no FAIL/MISSING rows for in-scope requirements **and** the deployment smoke test passes. Out-of-scope phases are reported as deferred, not as failures.

## Orchestrator rules
- Pass agents file paths and the exact task, not paraphrases of other agents' output.
- Never mark a gate passed without reading the verdict line in the file.
- If a loop iterates more than 3 times on one Blocker/High item, stop and ask the user.
- Honest reporting: untested-on-Windows and untested-against-Bloomberg items stay flagged until verified on the target workstation (spec section 56).
