# TEST_INFRA.md: E2E Testing Track Infrastructure & Methodology

**Author**: teamwork_preview_test_writer_e2e_1  
**Integrity Mode**: Development / Strict Opaque-Box  
**Target Repository**: `dinilmusick/ATAX`  
**Test Suite Location**: `tests/e2e-data-api/`  
**Target Architecture**: Supabase PostgREST Data API (`POST /rest/v1/rpc/<name>`) & Cloudflare Worker MCP Endpoint (`POST /mcp`, `GET /health`)

---

## 1. Testing Methodology & Principles

The ATAX E2E Test Suite is designed according to rigorous opaque-box testing methodologies to ensure the MCP Server and Supabase Data API migration fulfills all protocol contracts, functional semantics, safety invariants, and performance boundaries.

### 1.1 Four-Tier Testing Methodology

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Tier 4: Real-World Scenarios                      │
│             (Autonomous Lifecycles, Recovery, Contention)              │
├────────────────────────────────────────────────────────────────────────┤
│                    Tier 3: Cross-Feature Combinations                  │
│               (Pairwise State Transitions, Fencing Guards)             │
├────────────────────────────────────────────────────────────────────────┤
│                 Tier 2: Boundary Value Analysis (BVA)                  │
│       (Auth Bounds, Lease Expiry, Nulls, 1MB Payload, 30 Batch)        │
├────────────────────────────────────────────────────────────────────────┤
│                      Tier 1: Feature Isolation                         │
│            (Initialize, Tools/List, Reads, Writes, Sockets)            │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Category-Partition Method (TSL)**:
   - Functional inputs and protocol messages are partitioned into distinct equivalence classes:
     - Valid vs. invalid headers, tokens, and payloads.
     - Authorized owner vs. unauthorized principals.
     - Valid scalar and composite types vs. malformed types.
   - Representatives from each equivalence class are exercised in isolation (Tier 1).

2. **Boundary Value Analysis (BVA)**:
   - Boundaries identified in protocol and storage constraints are tested at, immediately below, and immediately above the limit (Tier 2):
     - **Payload size**: Exactly 1MB (1,048,576 bytes) accepted/rejected vs. 1,048,577 bytes rejected with HTTP 413.
     - **Batch limit**: Exactly 30 requests accepted vs. 31 requests rejected with HTTP 400.
     - **Lease durations**: Minimum 60s, maximum 900s.
     - **Token string lengths**: Minimum 12 characters, SHA-256 64-hex format.
     - **Task counts**: 1 to 4 finite tasks per bounded goal.

3. **Pairwise / Combinatorial Testing**:
   - State transition interactions between dependent ledger features are validated across all valid and invalid sequences (Tier 3):
     - `claim_next` ➔ `check_claim`
     - `claim_next` ➔ `heartbeat`
     - `claim_next` ➔ `task_submit`
     - `task_submit` ➔ `claim_verification` ➔ `verify_result`
     - `claim_next` ➔ `task_release` ➔ `reclaim`
     - `claim_next` ➔ forfeiture ➔ `task_handoff`

4. **Workload & Operational Profile Testing**:
   - Realistic multi-step workflows modeling autonomous agents operating within the ATAX governance model (Tier 4):
     - Complete task loop lifecycle with loop iteration recording, evidence submission, and independent verifier review.
     - Ephemeral lease expiration, forfeiture detection, non-mutating handoff note recording, and recovery.
     - Restricted task socket metered transactions with budget profiles and token consumption receipts.
     - Multi-agent concurrency contention testing verifying mutual exclusion of atomic claims.

---

## 2. Feature Inventory Mapping

Every feature identified in `PROJECT.md` is mapped to authoritative contracts, verification tiers, and test implementations:

| # | Feature | Contract / RPC Name | Authoritative Source | Verification Tiers | Test Module |
|---|---------|---------------------|----------------------|--------------------|-------------|
| 1 | MCP Handshake | `initialize`, `ping` | MCP Protocol Spec 2025-06-18 | Tier 1, Tier 2 | `tier1-feature-coverage.test.mjs`, `tier2-boundary-corner.test.mjs` |
| 2 | Tool Discovery | `tools/list` | `tools/atax-mcp/worker.mjs:184` | Tier 1 | `tier1-feature-coverage.test.mjs` |
| 3 | Read Tools | `atax_context`, `agent_context_overview`, `goal_ledger_overview`, `atax_system_context`, `atax_goal_get` | `supabase/migrations/20261103030000_secure_goal_overview.sql` | Tier 1 | `tier1-feature-coverage.test.mjs` |
| 4 | Write/Claim Tools | `task_ledger_claim_next`, `task_ledger_check_claim`, `task_ledger_heartbeat_claim`, `task_ledger_release_claim` | `supabase/migrations/20261120124500_preserve_global_claim_recovery_evidence.sql` | Tier 1, Tier 3 | `tier1-feature-coverage.test.mjs`, `tier3-cross-feature.test.mjs` |
| 5 | Verification Tools | `task_ledger_claim_verification`, `task_ledger_verify_result_claimed`, `atax_verification_pending` | `supabase/migrations/20261102142548_make_worker_and_verifier_claims_exclusive.sql` | Tier 1, Tier 3 | `tier1-feature-coverage.test.mjs`, `tier3-cross-feature.test.mjs` |
| 6 | Socket Execution | `atax_socket_execute_v1`, `atax_socket_task_status`, `atax_socket_context_pull`, `atax_socket_output_submit` | `supabase/migrations/20261122170200_socket_gateway_transaction.sql` | Tier 1, Tier 4 | `tier1-feature-coverage.test.mjs`, `tier4-application-scenarios.test.mjs` |
| 7 | Authentication & Tokens | Bearer SHA-256 digest & OAuth at+jwt validation | `tools/atax-mcp/worker.mjs:75-135` | Tier 2 | `tier2-boundary-corner.test.mjs` |
| 8 | Lease Expiry & Fencing | Atomic fencing tokens & lease enforcement | `supabase/migrations/20261113170000_harden_ephemeral_agent_heartbeat_leases.sql` | Tier 2, Tier 3, Tier 4 | `tier2-boundary-corner.test.mjs`, `tier3-cross-feature.test.mjs`, `tier4-application-scenarios.test.mjs` |
| 9 | Schema Boundaries | Strict parameter typing & enum checks | `tools/atax-mcp/worker.mjs:156-167` | Tier 2 | `tier2-boundary-corner.test.mjs` |
| 10 | Payload Limits | 1MB max body size (1048576 bytes) | `tools/atax-mcp/worker.mjs:8, 242` | Tier 2 | `tier2-boundary-corner.test.mjs` |
| 11 | Batch Limits | Maximum 30 JSON-RPC requests | `tools/atax-mcp/worker.mjs:245` | Tier 2 | `tier2-boundary-corner.test.mjs` |
| 12 | Health Check | `GET /health` (`databaseTransport: supabase-data-api`) | `PROJECT.md § Health Endpoint Contract` | Tier 1 | `tier1-feature-coverage.test.mjs` |
| 13 | Cross-Feature Loops | Pairwise claim, heartbeat, submission, verification | Canonical ATAX Agent Instructions | Tier 3 | `tier3-cross-feature.test.mjs` |
| 14 | Operational Lifecycles | End-to-end task loops, forfeiture recovery, concurrency | `docs/connection-modes.md` | Tier 4 | `tier4-application-scenarios.test.mjs` |

---

## 3. Test Architecture & Harness Design

### 3.1 Self-Contained Opaque-Box Execution
The test suite communicates exclusively via standard HTTP network requests:
- **Zero White-box Mocking**: Tests do not inject mock objects into internal Worker functions. All calls are made via standard `fetch()` over HTTP.
- **Zero External Dependencies**: Built entirely on native Node.js 20+ modules (`node:test`, `node:assert/strict`, `node:http`, `node:crypto`).

### 3.2 Dual-Mode Execution Harness
The test harness (`tests/e2e-data-api/harness.mjs`) automatically supports two execution targets:
1. **Local In-Process Mock Fixture Mode (Default)**:
   - Spawns a high-fidelity, in-memory HTTP server (`tests/e2e-data-api/mock-server.mjs`) on an ephemeral port.
   - Accurately models the Cloudflare Worker MCP gateway (`/mcp`, `/health`) and the Supabase PostgREST Data API (`/rest/v1/rpc/<name>`).
   - Implements full stateful ledger semantics: task queues, atomic claims, fencing tokens, lease timers, verification queues, handoff events, and socket transactions.
   - Guarantees 100% deterministic, offline execution with zero flaky network dependencies.
2. **Live Target Mode**:
   - When environment variable `ATAX_MCP_URL` is set (e.g. `ATAX_MCP_URL=https://atax.todadjp.workers.dev`), the harness skips the local mock and executes all tests directly against the deployed Cloudflare Worker and Supabase project `vcaerawuwffziufvpbvw`.

---

## 4. Test Suite Structure & Commands

```
tests/e2e-data-api/
├── mock-server.mjs                  # In-memory PostgREST & MCP Worker simulation server
├── harness.mjs                      # Test harness & client helper library
├── tier1-feature-coverage.test.mjs  # Tier 1: Isolation tests (>=5 cases per feature)
├── tier2-boundary-corner.test.mjs   # Tier 2: Boundary & corner cases (>=5 cases per boundary)
├── tier3-cross-feature.test.mjs     # Tier 3: Pairwise state transitions & fencing guards
├── tier4-application-scenarios.test.mjs # Tier 4: Real-world lifecycles & operational profiles
└── run-all.mjs                      # Master test runner & reporter
```

### Execution Commands

```bash
# Run complete E2E test suite (all tiers):
node tests/e2e-data-api/run-all.mjs

# Run via native Node.js test runner:
node --test tests/e2e-data-api/*.test.mjs

# Run against live deployed Worker & Supabase:
ATAX_MCP_URL=https://atax.todadjp.workers.dev ATAX_MCP_TOKEN=<token> node tests/e2e-data-api/run-all.mjs
```
