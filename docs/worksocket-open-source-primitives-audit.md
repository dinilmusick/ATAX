# WorkSocket open-source primitives audit

**Checked:** 2026-11-27  
**Scope:** queue claims, locking/fencing, workflow state, frontend statecharts and property-based testing.

The rule for adoption is architectural fit, not feature count: ATAX remains the durable task graph and authorization authority. A library must not introduce a competing orchestrator, resident worker pool, task ledger or alternate permission system.

| Candidate | License / maturity observations | Fit and decision |
|---|---|---|
| [Graphile Worker](https://github.com/graphile/worker) | MIT. Mature PostgreSQL-backed queue. Its documented design uses `FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY`, retries and backoff. The repository is actively maintained and its current package line is 0.18.x. | **Do not adopt as a queue.** ATAX already uses atomic PostgreSQL row locking, leases, claim tokens and task events. Graphile Worker introduces a separate Node worker process and queue lifecycle that conflicts with ATAX's transient externally-created agents and persistent-state-only coordination. Reuse the database patterns conceptually, not its competing runtime. |
| [Temporal](https://github.com/temporalio/temporal) | MIT. Very mature distributed workflow platform with a dedicated server, durable workflow history and long-running workers polling task queues. | **Do not adopt.** Temporal is a strong standalone orchestration platform, but importing it would create a second workflow server, state history and worker-polling runtime. ATAX already owns these semantics in Supabase and explicitly does not spawn/schedule resident agents. |
| [XState](https://github.com/statelyai/xstate) | MIT. Mature statechart/state-machine implementation with active repository development. | **No immediate dependency.** It may be useful for a future local-only management UI statechart (filters, tabs, view transitions). It must never own authoritative WorkSocket state or server transitions. The existing UI can render canonical state without this dependency today. |
| [fast-check](https://github.com/dubzzz/fast-check) | MIT. Actively maintained property-based testing library. The npm registry reported 4.11.0 during this audit; repository release tags may lag the npm publish. | **Candidate for test-only adoption.** It is well suited to generate boundary cases for budgets, cursors, attenuation and fencing. It is not installed in the root package and is not needed for the current SQL migration. Add it only when the property suite is introduced, pin it as a dev dependency and commit the lockfile. |

## Existing primitives reused

- PostgreSQL row locks and `FOR UPDATE SKIP LOCKED` for atomic task selection.
- Unique opaque claim tokens and short expiring leases for write fencing.
- Database triggers for active-socket exclusivity and recovery audit.
- Existing `socket_invocations`, scoped capability grants, task budgets and usage events.
- Existing completion-predicate registry and append-only predicate execution receipts.
- Existing task dependency graph and child-task relationship.

## Adoption outcome

No new orchestration or queue dependency is justified. The implementation extends the existing Supabase ledger and socket gateway. A future property-based test package is a viable, isolated dev-only enhancement; it is not an execution dependency.
