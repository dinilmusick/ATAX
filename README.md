# ATAX

ATAX provides three distinct capabilities:

1. **Goal and task coordination — Supabase PostgreSQL.** Goals, parent tasks, dependencies, leases, loop iterations, parameters, evidence, verification and finalization are persisted and enforced by database RPCs.
2. **Coding execution — GitHub Issues and PRs.** Each independent coding task gets one Issue as its durable execution state and one dedicated PR as its implementation artifact. Workers persist blockers and resume points in Issues; the orchestrator polls Issues/PRs/CI and writes decisions back to Issues.
3. **Reasoning and orchestration — ChatGPT conversations.** The user opens the orchestrator and worker chats. Chats load and update shared state directly through the connected Supabase tools.
4. **Finite compute — GitHub Actions.** The Agent Compute Workspace runs source files from a selected repository revision on an ephemeral GitHub-hosted runner and returns an artifact.

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

ATAX is designed for fragile, ephemeral agents. Workers reconstruct context from Supabase and GitHub Issues rather than chat history. Active tasks heartbeat/checkpoint about every 2 minutes and independently check ownership about every 5 minutes; tasks without a heartbeat for at least 5 minutes can be atomically recovered. Claim tokens fence stale workers. Loop contracts are authored by one worker and executed by a different worker, so success parameters cannot be self-authored and self-certified. Every worker persists progress, blockers, evidence and resume state before disappearing, and terminal completion requires independent verification.

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
