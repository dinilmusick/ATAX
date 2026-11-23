# ATAX → Google AI Studio: React UI handoff (read-only v1)

**Status:** specification for a future React frontend, **not a claim that a React app/API already exists**. Canonical backend and task semantics must remain intact. Start from the current `main` snapshot and add a self-contained UI package; do not reorganize, replace, or mock the substrate as a side effect.

## Invariants

- Supabase PostgreSQL is the only durable truth for universe, systems, visions, goals, tasks, dependencies, skills, memories, evidence, claims, and verification.
- ATAX is a substrate for **externally arriving transient agents**. The UI never spawns, schedules, runs, or auto-claims agents/tasks. No model/vendor-specific scheduling or new resident orchestrator.
- Preserve all three entry modes: direct GitHub+Supabase, authorized GitHub-only control bridge, authenticated remote MCP. Do not route direct connectors through the Worker.
- Keep existing RPCs and fenced claim/lease/heartbeat/verification contracts unchanged. New UI code must be isolated; never silently rewrite schema/migrations, Worker, or CI.
- **Read-only first release:** no create/edit/delete/reorder/claim/trigger/eval/secret-management actions. Leave future manual vision/goal/task authoring out of the first draft.
- Never move Supabase secret keys or GitHub/Cloudflare/Vercel tokens into React/browser bundles, `VITE_*`, `NEXT_PUBLIC_*`, HTML, logs, or local storage. Browser obtains only safe, authorization-filtered graph projections from an authenticated server-side adapter. Do not render secret values or raw claim/fencing tokens.
- Use real states and evidence. If an API or particular graph interpretation is not yet implemented, show **Unavailable / Not verified**. Do not fill with invented example accounts, jobs, timestamps or activity.

## Views (first draft)

1. **Universe / Systems**: browse systems and current priorities, status, applicable goals and constraints.
2. **Vision graph**: nested Goal nodes inside a Vision container. Show goal-to-goal dependency edges. Preserve the canonical vision-target intermediate layer in the data adapter (do not discard `vision_targets` / `vision_target_goals`).
3. **Goal graph**: Task nodes nested in each Goal, with task dependency edges, parallel chains and convergence. Typed connectors visually distinguish completion dependencies, artifact/data transfer, and guarded conditional flow. Only draw decision/branch nodes where canonical source data supports them; planned graph semantics are not yet an implemented DB schema.
4. **Task details**: task definition, inputs/outputs, status, mandatory/optional/applicable state where explicitly available, action/checkpoint progress, dependencies, blockers, attempts, completion evidence, eval state, and independent verification.
5. **Live occupancy overlay**: on task hover (and keyboard focus / click for mobile), show agent display label, opaque claim-holder ID (if authorized), claimed-at timestamp, last heartbeat, lease-expiry time and task progress. Never infer an active agent merely from a name: distinguish `lease valid`, `lease expired`, `no claim`, and `unknown`. Re-fetch/read fresh state; timestamps alone are not proof of current occupancy.
6. **Evidence and evals**: a read-only summary of task eval pending/failed/passed, latest revision and verifier evidence if supported; clearly label planned goal- and vision-level eval gating as **not yet implemented** until production code exists.

## Agent display naming

Display: `Agent · YYYY-MM-DD HH:mm:ss z` using the agent invocation/claim timestamp where available; show a stable shortened opaque holder suffix to disambiguate same-second claims. This is a **presentation label, not a persistent agent registry**. Use ISO 8601 UTC from the API and format in user's selected timezone; show exact timezone and full timestamp on hover. If no invocation creation timestamp was recorded, use `claimed_at` and label it **Claimed**, not **Created**. Do not derive agent identity from the AI vendor, model or account.

## Existing canonical read sources (schema must be introspected, not assumed)

- `systems`, `visions`, `vision_targets`, `vision_target_goals`, `goals`, `tasks`.
- `goal_dependencies`, `task_dependencies`, `task_events`, `task_iterations`.
- `system_constraints`, `system_memories`, `completion_predicates`, `predicate_executions` (currently task-scoped).
- Task lease/occupancy fields already include `claimed_by_agent_id`, `claimed_by_agent_name`, `claimed_at`, `heartbeat_at`, `claim_expires_at`, `status`, `verification_status`, `heartbeat_context`. Authorize and redact the projection.

Do not interpret `parent_task_id` as proof that nested task execution is implemented; current bounded-v2 creation enforces top-level executable tasks. Distinguish **desired** atomization/conditional graph model from **deployed** behavior. Future graph edges and decision nodes require versioned backend contracts and tests, not UI-only changes.

## Proposed frontend/backend boundary (not an existing API)

```text
React (read-only) -- same-origin, authenticated GET --> UI backend adapter
UI backend -- authorized RPC/query --> canonical Supabase
UI backend -- optional scoped server credentials --> authorized provider diagnostics
```

A future backend can expose `GET /api/graph/visions`, `GET /api/graph/goals/:id`, `GET /api/graph/tasks/:id` and `GET /api/graph/occupancy`. These are **proposed routes only**; implementing and authenticating them is separate work. Use narrowly scoped, pagination-friendly responses and server-side authorization. Graph viewers must not gain ATAX mutation privileges from the ability to view a graph.

## Read-only acceptance

- Frontend builds without a Supabase service key or provider token in generated JS/assets.
- Browser network requests contain no secret key, unredacted claim token, or service-role credential.
- A real authorized user sees the correct vision/goal/task graph and dependencies from canonical records; denied/unavailable data fails closed.
- Parallel prerequisite chains and inactive branches are visualized only when canonical edge semantics permit, with an explicit unknown state otherwise.
- Task hover/focus shows real claim, heartbeat and lease timestamps with timezone; stale leases are not labeled active.
- No mutation, agent spawning, synthetic evaluation pass, or task completion comes from page rendering.
- Existing backend and three connection modes pass regression checks on unchanged source.

## Handoff checklist for Google AI Studio

1. Import the repository at a reviewed `main` commit. Treat `AGENTS.md`, `docs/architecture.md`, `docs/connection-modes.md` and this file as constraints.
2. Add an isolated React client and an authenticated server adapter. Preserve existing tools, migrations, MCP Worker and workflows.
3. Use `docs/ENVIRONMENT_CONFIGURATION.md` plus root `.env.example` to configure **server-only** bindings. AI Studio's client environment must receive **only** public configuration.
4. Run build/unit/UI tests and existing MCP/substrate tests. Capture changed-files list, actual backend connectivity, auth denials, data correctness and a before/after regression report.
5. Do not claim live integration merely because a React mock displays a graph. Full validation requires live authorized Supabase reads and independent evidence.
