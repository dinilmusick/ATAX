# ATAX architecture

## Substrate, not agent runtime

ATAX holds durable **state**; it does not create, schedule, identify by AI vendor, or run agents. External agents arrive, read applicable context and current skills, claim finite tasks where eligible, execute externally, persist outcomes and leave. Future agents reconstruct continuity from the same ledger. Chat history and GitHub Issues are not the source of truth.

The canonical persistent store is **Supabase PostgreSQL**, containing the universe/system hierarchy, goals, constraints, memories, skills, dependency graphs, finite tasks, task socket occupancy, leases, checkpoints, evidence, verification and finalization. Atomic PostgreSQL functions enforce safe transitions. No Cloudflare Worker, GitHub Action or chat can replace that authority.

## Exactly three supported connection modes

```text
       External transient agent (any application/model/provider)
                                 |
                 +---------------+----------------+
                 |               |                |
           GitHub only       GitHub + Supabase   ATAX remote MCP
                 |               |                |
        Repo-native tools     Direct GitHub      Cloudflare Worker
        / trusted Actions     and Supabase       authenticated /mcp
                 |               |                |
          Authorized ledger     RPCs directly    Bounded MCP tools
          client/bridge           |                |
                 +---------------+----------------+
                                 |
                      Same Supabase ledger
                     atomic task-socket RPCs
                                 |
                        Evidence and state
                   independently verified result
```

1. **GitHub connector only:** the agent connects to `dinilmusick/ATAX` and can read its instructions/skills/tools and use authorized repository operations. Live database work is **not automatic**: a trusted, credential-bearing repository tool/Actions bridge must call the canonical Supabase RPCs. GitHub Actions secrets are available only to trusted jobs that explicitly map them. Full live GitHub-only task-socket bridge parity is an outstanding acceptance gap, not a verified current feature.
2. **GitHub plus Supabase connectors:** the existing direct ChatGPT/agent GitHub and Supabase workflow remains unchanged. Read canonical live state and transact through Supabase guarded RPCs, while GitHub handles repositories, workflows, Issues and PRs. The direct route never depends on MCP availability.
3. **Remote ATAX MCP:** Claude, Gemini and other compatible external clients authenticate to the single-owner Cloudflare Worker `/mcp` endpoint. The Worker accesses the same Supabase ledger and bounded GitHub/Cloudflare tools through server-side secrets. It is not a tenant vault, a second ledger, a worker pool or an agent scheduler. Actual native-client interoperability remains subject to separate live checks.

**The connection transport changes; the substrate contract does not.** Tool-surface parity is an objective, but current MCP Cloudflare operations are read-only and GitHub-only live-ledger bridge parity is not yet certified. See [connection modes](connection-modes.md).

## Task socket model

```text
 queued (available)
    |
    | atomic claim (row lock; exactly one successful claimant)
    v
 running (occupied by one valid lease + opaque fencing token)
    |             |
    | heartbeat   | abandoned/expired → recover with a new fencing token
    |             |                     old token is permanently invalid
    v             v
 submitted / pending independent verification
    |
    v
 verified / finalized
```

The substrate tracks socket occupancy, not the model/application that arrives. Existing SQL `agent_id` arguments are opaque claim-holder compatibility fields; they are not an AI-vendor registry, scheduler, or durable resident-agent identity. Claim and verification contracts currently use these fields, so removal requires an independent, nonbreaking database migration.

The canonical database must reject a competing claimant while the existing lease remains valid, even if its last heartbeat is stale. Reclamation after valid expiration rotates the fencing token; old holders must be barred from new canonical writes. Externally started work cannot be forcibly cancelled by the database: use idempotent operations and independent reconciliation for side effects.

All transports must route through the same atomic claim, heartbeat, evidence submission, release, verifier claim and finalization invariants. A GitHub Issue, PR label, MCP session or in-memory mutex cannot substitute for the canonical task-socket lock.

## Fenced-out agent continues on another task

```text
lost-or-expired-lease(task A)
  → stop external work affecting A
  → append non-mutating handoff(task A, old fence, partial result, evidence, next step)
  → refresh Supabase task socket availability
  → select an eligible free task B (not task A or another occupied socket)
  → atomic claim(task B) → execute using B's new fence
  → repeat as work remains
```

A lease-loss event **forfeits the task socket, not the entire externally running agent**. If no free finite task is eligible, the agent may discover applicable always-available work under the canonical modality catalogue. It does not wait for the substrate to spawn it or schedule another agent. Task A's replacement owner remains exclusively entitled to canonical writes. A stale holder's `task_ledger_record_handoff` is append-only audit evidence, not a task update, submission, release or ownership transfer.

## Execution and verification

- Compute normally occurs in the arriving agent's own container on the **target repository**. ATAX itself must never serve as the checkout or runner for target code.
- If authorized local execution is insufficient, use an approved disposable **public FMRL-*** bridge; private target code exists only in its transient runner, then the FMRL repository is deleted and independently checked absent. The deprecated Agent-Workspace-1 and ATAX-native private-code execution paths are forbidden.
- Every task has bounded actions, dependencies, outputs, verification criteria and finite loops; evidence is persisted before the agent leaves.
- Submitted results are not verified results. An independent verifier reviews evidence under the canonical verification contract, and goals finalize only once acceptance criteria are satisfied.

## Security and deployment boundaries

- Supabase is the canonical ledger, not a general hosted execution platform.
- Direct GitHub and Supabase connectors retain their independent account-specific authorizations.
- GitHub repository secrets power specifically approved Actions jobs; Cloudflare Worker secrets power the MCP endpoint. They can use matching names but **are not synchronized secret stores**.
- The personal MCP Worker uses one ledger and owner-managed `GH_KEY_<ALIAS>` and `CF_KEY_<ALIAS>` secrets. It does not store tenant credentials or automatically provide direct connectors to MCP clients.
- No credentials, private source, privileged database keys, or raw private logs belong in public commits, prompts, MCP tool schemas/results, or public FMRL artifacts.
- A public Worker health check, simulated test, or dispatch acknowledgement is not proof of authenticated end-to-end task execution.

See [security](security.md), [task ledger](task-ledger-integration.md), [agent instructions](../AGENTS.md) and [MCP owner setup](../tools/atax-mcp/OWNER_SETUP.md).
