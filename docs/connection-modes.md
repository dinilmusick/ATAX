# ATAX connection modes — three entrances, one substrate

**Canonical contract:** ATAX is the persistent substrate for externally created, transient agents. It stores state, goals, constraints, memories, skills, work, evidence, and acceptance conditions in **one canonical Supabase ledger**. It **does not** create, schedule, identify by model/vendor, or host resident agents. Agents work outside the substrate and persist results back through its guarded operations.

## Supported entry modes

| Mode | Agent connects to | How ATAX state is accessed | Where credentials live |
| --- | --- | --- | --- |
| **1. GitHub connector only** | [`dinilmusick/ATAX`](https://github.com/dinilmusick/ATAX) | Read instructions, skills, tools and workflows in this repo; for **live ledger reads/writes**, invoke an appropriately authorized GitHub-native ATAX workflow/tool which uses the Supabase client and canonical guarded database RPCs. GitHub alone does **not** expose or automatically read the Supabase ledger. | GitHub connector identity for repository operations; Supabase credentials in **trusted GitHub Actions secrets** or an authorized, secret-bearing agent runtime, never in source or workflow input |
| **2. GitHub + Supabase connectors** | The ATAX repo **and** the user's existing direct Supabase connector | Hydrate canonical context and skills directly from Supabase; use GitHub for repo tools, issues, PRs, workflows and source. Direct database task claims and submissions invoke the exact same guarded Supabase RPCs used by other modes. | Each connector's own account-granted authorization. GitHub repository secrets are not visible merely because the connector can read the repository. |
| **3. ATAX remote MCP** | A single authenticated Streamable HTTP endpoint, `https://atax.dextro1n1laevo.workers.dev/mcp` | MCP tool calls use bounded operations backed by the **same** canonical Supabase RPCs over **HTTPS Data API / PostgREST** (`ATAX_SUPABASE_URL` + `ATAX_SUPABASE_SECRET_KEY`) and GitHub/Cloudflare provider APIs. This is an alternate entry point, not an independent ledger or agent runtime. | `ATAX_SUPABASE_URL` and `ATAX_SUPABASE_SECRET_KEY` as Cloudflare Worker secrets; GitHub/Cloudflare tokens encrypted in **Supabase Vault**; the MCP client authenticates separately to the Worker. |

The three modes are **interfaces to one substrate**, not three separate implementations. Never require a direct-connector agent to access the MCP Worker. Never make the canonical database a mirror of GitHub Issues, a repository file, D1, KV, or a chat transcript.

## Common work protocol for every mode

1. **Connect → hydrate:** load the authoritative Supabase universe, system priorities, goals, active constraints, skills, memories, evidence, dependencies and outstanding work before deciding what to execute. In GitHub-only mode this requires an actual credentialed tool/workflow request for live state: repo instructions alone are not hydration.
2. **Discover task sockets:** identify a bounded, eligible task using canonical priority, dependencies and constraints, or derive a finite work unit from always-available constraint enforcement, implementation push, health, or optimization.
3. **Claim atomically:** attempt a canonical Supabase task-claim operation. A task socket has **at most one active, valid lease/fencing token**. Concurrent claim attempts must not both succeed. No local GitHub lock or MCP memory can override the database.
4. **Execute externally:** the incoming agent does the actual work using its own tools/container. ATAX never spawns, schedules, runs, or retains that agent. For code execution, use target-repo containers first and only the approved disposable FMRL public bridge workflow when needed; never execute target code in ATAX's Actions workspace.
5. **Detect lease loss → forfeit socket, not agent session:** check claim ownership every 30–60 seconds and immediately before every task mutation. If the lease expired or a different claim replaced it, stop side effects on the previous task, append a bounded `task_ledger_record_handoff` note using the old claim token with progress, partial results, blockers and evidence. This is an append-only note and **cannot** restore ownership or overwrite the new occupant. Refresh available work and atomically claim another eligible task; keep working as an external agent.
6. **Persist → independently verify:** record iterations, evidence, bounded outputs, and result submission in Supabase. Completion depends on independent verification and acceptance. Release or expire task leases with strict fencing; stale holders cannot mutate the canonical socket after transfer.
7. **Leave only after eligible work is exhausted or the user ends the session:** on a lost claim, the agent does **not** terminate; it forfeits that socket and seeks another. Future agents reconstruct state from the substrate, not conversation memory.

**Socket invariant:** `available → claimed/exclusively occupied → submitted → independently verified → complete`. Lease recovery must never overlap a still-valid active lease. An expired holder's **external side effects** are not automatically stopped; use idempotent operations and independent reconciliation. The database's legacy `agent_id` fields are opaque holder/audit compatibility fields, **not** a Gemini/Claude/ChatGPT registry and not a reason for task scheduling.

## Mode-specific configuration

### Mode 1 — GitHub connector only

- Connect an agent to the ATAX repository with the GitHub connector. Read `AGENTS.md` and this document.
- Use the bundled dependency-free `tools/supabase-agent-client/supabase_client.py` from a trusted runtime that has `SUPABASE_URL` and a suitably scoped `SUPABASE_SECRET_KEY`, **or** an explicitly authorized GitHub Actions workflow that maps its stored secrets into that runtime.
- GitHub Actions repository secrets are not exposed by ordinary GitHub file APIs or automatically passed to third-party agents. Workflows must securely map only the secrets they need; prohibit arbitrary SQL/commands or user-supplied code from privileged jobs.
- The existing `.github/workflows/supabase-substrate.yml` is only a **migration/deployment** workflow. For a GitHub-connector-only agent with no independent Supabase credential, ATAX now provides [private GitHub controller bridge tooling](../tools/github-only-ledger-bridge/README.md): install its allowlisted issue workflow in a **separate private controller repository** with scoped GitHub Actions secrets. An agent with access to both the public ATAX source and that private controller can request live ledger RPCs through GitHub alone. The public ATAX repository must never relay private ledger responses. **Operational certification remains pending** until a real private controller, granted actors, and live socket/verification checks are exercised.
- GitHub's own issue/PR state may hold execution artifacts, but it cannot supersede canonical database socket occupancy.

### Mode 2 — GitHub plus Supabase connectors

- Continue the existing ChatGPT-agent workflow unchanged. The GitHub connector handles code/repositories, and the Supabase connector reads/writes canonical ledger RPCs directly.
- Perform atomic claims and heartbeat/submission/verification through the Supabase connector; avoid making direct table writes that bypass the RPC guards.
- GitHub outages may block GitHub operations but do not change canonical Supabase claims. MCP outages do not affect either direct connector.

### Mode 3 — ATAX remote MCP

- Authenticate the single-owner client to the `/mcp` protected resource using the configured owner OAuth flow (or an explicitly configured owner bootstrap token where client support permits).
- The Worker runtime holds only `ATAX_SUPABASE_URL` and `ATAX_SUPABASE_SECRET_KEY` (communicating with Supabase **exclusively via HTTPS Data API / PostgREST**). Named GitHub/Cloudflare credentials live encrypted in **Supabase Vault** via `/api/settings/providers`, and Vercel integration stays disabled (`501`).
- The Worker must not store provider credentials in D1, expose them in tool arguments/results, or mutate local task state instead of the Supabase RPCs.
- `GET /health` proves only liveness. Real acceptance requires authenticated initialization, tools/list, Supabase read, atomic claim fencing, account selection, and independent verification.
- **Current scope warning:** this MCP implementation exposes a bounded subset of GitHub tools and **read-only** Cloudflare diagnostics; full capability parity across modes is an intended contract, **not an already verified fact**. Claude/Gemini native client interoperability requires separate production evidence.

## Safety and parity rules

All modes must produce equivalent **durable ledger transitions** for the same operations, even where UI or tool catalogues differ. Do not duplicate workflows, introduce alternate authoritative databases, or relax socket/verification rules for a convenience entry path.

| Invariant | GitHub-only bridge | Direct Supabase | MCP Worker |
| --- | --- | --- | --- |
| Same canonical ledger and live skills | Required, **not yet fully bridge-certified** | Existing native connector | Same Supabase RPC mappings |
| Atomic task claim, lease, fencing and stale-token rejection | Must be proven end-to-end | Required DB functions | Required DB functions |
| No model/vendor-specific substrate identity | Required | Required | Required |
| Independent verification/acceptance | Required | Required | Required |
| Provider credentials hidden from agent-visible outputs | GitHub Actions secrets | Connector-managed | Worker secrets |
| Never execute target work inside ATAX itself | Required | Required | Required |

## Verification checklist

A release can claim universal **three-mode parity** only after testing the same controlled task socket through each entry: an available claim succeeds; a second simultaneous attempt fails; heartbeat retains occupancy; expired claims are fenced; submission preserves evidence; independent verification completes; and no pathway can bypass these guarantees. Never declare parity from a README, passing unit mocks, or a Worker health response.

See [ATAX MCP owner setup](../tools/atax-mcp/OWNER_SETUP.md), [Task ledger skill](../skills/task-ledger/SKILL.md), and [Agent instructions](../AGENTS.md).
