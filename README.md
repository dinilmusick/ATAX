# ATAX

ATAX is a durable substrate for **externally created, transient agents**. One canonical Supabase ledger holds systems, goals, tasks, dependencies, constraints, memories, skills, claims, evidence and verified results. ATAX never spawns, schedules or hosts agents.

## Three connection modes

| Mode | Entry point | Durable state |
| --- | --- | --- |
| **GitHub connector only** | Agents read this repository and use authorized repository tools or trusted workflows. Live ledger access uses an authorized runtime or the [private GitHub-only ledger bridge](tools/github-only-ledger-bridge/README.md) with configured secret-bearing Actions; public repo access alone is insufficient. | Same Supabase ledger; GitHub alone does not grant database access |
| **GitHub + Supabase connectors** | Existing direct ChatGPT/agent workflow: GitHub for code and workflows; Supabase for canonical context and guarded ledger RPCs. | Same Supabase ledger |
| **ATAX remote MCP** | External AI clients connect to the owner-authenticated Cloudflare Worker at `/mcp`, which calls canonical RPCs and bounded provider tools. | Same Supabase ledger |

**All three must enforce one occupied task socket at a time** through database-atomic claims, leases and fencing tokens, with external execution and independent verification. No tool/client/model/vendor-specific identity belongs in task scheduling. Tool coverage is not yet identical: the GitHub-only live-ledger bridge and native third-party MCP certification remain explicit acceptance gaps.

Read [**Connection modes and guarantees**](docs/connection-modes.md) and [**Architecture**](docs/architecture.md) first.

**Google AI Studio / React handoff:** [Read-only node graph UI specification](docs/AI_STUDIO_REACT_HANDOFF.md) · [Provider and backend environment-variable contract](docs/ENVIRONMENT_CONFIGURATION.md) · [blank `.env.example`](.env.example). The proposed React UI is not yet deployed; sensitive provider keys must never be put in a browser build. For the personal MCP Worker, see [owner setup](tools/atax-mcp/OWNER_SETUP.md).

## Resume or create work

For an unfinished goal, ask a new chat to **“Start finishing an unfinished goal.”** The Universal Task Router loads the unfinished-goal list and resumes by readable goal key.

For a new objective, describe the outcome normally. The orchestrator creates a titled, tagged goal with its own loop and direct child tasks. Every task has its own loop, acceptance criteria, optional parameter contract and independent verification.

## Run code

## Mandatory FMRL execution boundary

ATAX is **only the control plane and tool source**, never a checkout workspace or GitHub Actions runner for target code. No target/private checkout, installation, build, test, `act` invocation, or coding commands may run in `dinilmusick/ATAX` Actions. The historical ATAX-as-workspace and Agent-Workspace-1 patterns are forbidden.

Execution priority:
1. Use the agent's own container/runtime; clone the **target repository** directly there (if authorized), edit and test locally. ATAX tools may be downloaded as tooling, but the ATAX repository must not become the target checkout or runner.
2. If local execution is unavailable, inaccessible, insufficient, or remote public Actions evidence is required, provision an **FMRL-prefixed, one-job disposable public repository** through `tools/github/disposable_workspace.py` or ATAX's control-plane workflow. This is the **only** remote GitHub compute location for private targets.
3. The FMRL public repository contains only bridge workflow code. Authorized private source is checked out **only inside its transient runner** and never pushed, artifacted, cached, or committed to the public repository. The checkout token is used only by the clone step; target commands receive no repository token.
4. Run and inspect checks, record evidence, obtain independent verification, **delete FMRL**, and independently confirm the repository returns 404. Deletion is mandatory on failure as well as success; failed cleanup is a blocker, not completion.
5. If FMRL cannot be provisioned, report the blocker and preserve work in the ledger. **Never fall back to ATAX or private-repository Actions execution.**

A new permanent repository (plain or Skipo) is a different lifecycle from disposable FMRL compute. Keep the two workflows separate.

Container-first execution does not require ATAX to host target code. FMRL is a disposable public compute bridge for private target CI; it is deleted after verification. Use `tools/github/disposable_workspace.py` and `.github/workflows/private-repo-ci.yml` only as the provisioning/control-plane entry points.

## Architecture

- [Architecture](docs/architecture.md)
- [Three connection modes and task-socket contract](docs/connection-modes.md)
- [Template portfolio candidate audit](docs/template-portfolio-candidates.md) — selected starter per category, source revisions and commercial-license clearance status.
- [Template portfolio coverage and acquisition manifest](docs/template-portfolio-catalog.md) — existing starters, missing product categories, exact upstream commits and private-research acquisition mode.
- [Commercial repository acquisition policy](docs/commercial-acquisition-policy.md) — private research mirrors are separate from approval for commercial reuse.
- [Goal and task ledger integration](docs/task-ledger-integration.md)
- [Chat-driven goal and worker protocol](docs/chat-agent-workflow.md)
- [Compute request contract](docs/compute-request.md)
- [Security model](docs/security.md)
- [Workspace layout](docs/workspace-layout.md)

## Model and agent tools

- [Model/agent tools](tools/models/README.md): disposable external model/agent launchers; current Argon/Carbon wrapper and the contract for future providers.

## Agent tools and skills

- [Looper](tools/looper/README.md): bounded loop-state controller for agent iterations.
- [Backend/API diagnostics](tools/backend-api-diagnostics/README.md): real local endpoint checks, contracts, auth/failure scenarios and correlated server-log artifacts.
- [Multi-service runtime](docs/multi-service-runtime.md): concurrent app services, health checks, ports, restart policies, logs and teardown.
- [Disposable database integration](docs/database-integration.md): isolated Supabase migration replay, SQL/RLS/RPC tests, schema drift checks and generated types.
- [Browser test harness](tools/react-typescript-fullstack/README.md): real-preview routes and workflows, responsive checks, traces, DOM/network evidence, axe accessibility and controlled visual baselines.
- [Platform adapters](skills/platform-adapters/SKILL.md): local Cloudflare Worker tests, Vercel preview diagnostics and local Supabase migrations/pgTAP.
- [Implementation Push](skills/implementation-push/SKILL.md): fresh whole-codebase completion passes that find incomplete implementation, rewire systems and verify end to end.
- [Persistent Multi-Agent Execution](skills/persistent-multi-agent-execution/SKILL.md): GitHub-Issue-backed durable worker/orchestrator execution, blocker persistence, polling and safe bulk continuation.
- [Tools catalogue](tools/catalog/README.md): curated coding, testing and browser tools.
- [Skills catalogue](skills/catalog.json): versioned skill snapshot backed by the Skills Database.

## Repository safety

This is a public repository. Never commit credentials, private source or personal data. GitHub-hosted compute is not a hardened hostile multi-tenant sandbox; do not use it to execute unknown users' code or process secrets.

## GitHub-native development

Create permanent applications with the repository creation / Skipo tools. For executing work use the agent's container first; if remote execution is necessary, use a disposable FMRL public runner. **Never use ATAX's own Actions workspace for target code.**

## Hardened worker model

ATAX is designed for fragile, ephemeral agents. Workers reconstruct context from Supabase and GitHub Issues rather than chat history. Active tasks heartbeat/checkpoint about every 2 minutes and periodically check ownership. Task recovery must preserve exclusive occupancy: it must not replace a **still-valid lease** merely because a heartbeat is stale. All recovery paths must rotate fencing tokens and reject stale holders. The canonical RPC audit for these invariants is ongoing. Claim tokens fence stale workers. Loop contracts are authored by one worker and executed by a different worker, so success parameters cannot be self-authored and self-certified. Every worker persists progress, blockers, evidence and resume state before disappearing, and terminal completion requires independent verification.

For the complete protocol, start with `AGENTS.md`, `skills/task-ledger/SKILL.md`, `skills/universal-task-router/SKILL.md`, `skills/coding-task-lifecycle/SKILL.md`, and `skills/persistent-multi-agent-execution/SKILL.md`.


## Checkpoint blocker / notoriety model

Bounded-v2 checkpoints persist a `blockers` array. Unresolved blockers are normalized and deduplicated globally, with one occurrence recorded per agent/task/checkpoint/attempt. The resulting **notoriety** score measures repeated failure: scores above 5 are surfaced as notorious blockers and become first-class user-attention items.

User-defined goal priority is a separate normalized 0..1 signal. Claim ordering is database-enforced as goal priority → blocker notoriety → task priority. Workers inspect the blocker overview before execution, attempt the highest-notoriety active blocker first, and persist unresolved blockers through the checkpoint blocker RPCs.


## Private-repository CI boundary

## Mandatory FMRL execution boundary

ATAX is **only the control plane and tool source**, never a checkout workspace or GitHub Actions runner for target code. No target/private checkout, installation, build, test, `act` invocation, or coding commands may run in `dinilmusick/ATAX` Actions. The historical ATAX-as-workspace and Agent-Workspace-1 patterns are forbidden.

Execution priority:
1. Use the agent's own container/runtime; clone the **target repository** directly there (if authorized), edit and test locally. ATAX tools may be downloaded as tooling, but the ATAX repository must not become the target checkout or runner.
2. If local execution is unavailable, inaccessible, insufficient, or remote public Actions evidence is required, provision an **FMRL-prefixed, one-job disposable public repository** through `tools/github/disposable_workspace.py` or ATAX's control-plane workflow. This is the **only** remote GitHub compute location for private targets.
3. The FMRL public repository contains only bridge workflow code. Authorized private source is checked out **only inside its transient runner** and never pushed, artifacted, cached, or committed to the public repository. The checkout token is used only by the clone step; target commands receive no repository token.
4. Run and inspect checks, record evidence, obtain independent verification, **delete FMRL**, and independently confirm the repository returns 404. Deletion is mandatory on failure as well as success; failed cleanup is a blocker, not completion.
5. If FMRL cannot be provisioned, report the blocker and preserve work in the ledger. **Never fall back to ATAX or private-repository Actions execution.**

A new permanent repository (plain or Skipo) is a different lifecycle from disposable FMRL compute. Keep the two workflows separate.

The former direct ATAX CI implementation and issue-triggered development runner are retired. Any legacy reference to ATAX as the execution repository is superseded by this rule.
