# ATAX Socket V1 — Agent B: canonical atomisation tests

Scope: database only. This branch adds the additive migration at supabase/migrations/20261122170000_socket_atomization_v1.sql plus tests in this directory. It does not modify gateways, legacy creators, controller code, or unrelated schemas.

## Invariants

- Each usage chunk is an immutable event, idempotent per (task_id, event_key). Separate retries that consume context must have separate event keys. Input and output counters are updated under a parent task row lock.
- A cumulative overrun stops the socket: parent status becomes waiting, the durable partial checkpoint is retained, a needs-atomization overflow report is inserted, and the claim/fence is released. Scope-based overflows do the same.
- The complete split is a single SQL transaction: validate the live fence (or prior stopped overflow); make the parent non-executable; record provenance; create 2–16 bounded-v2 child tasks, each with 1–4 actions, exactly one independently verifiable outcome, explicit input/output contracts, a ready loop contract, and a budget; insert typed sibling dependencies. Any error rolls the entire split back, including the stop.
- Child tasks are initially waiting, not in the legacy global task-claim pool. socket_claim_child requires a fresh registered invocation and assigns a fresh fencing token. A child can itself stop and atomise recursively.
- The atomiser agent ID, invocation ID and session ID cannot claim any child it created, including attempts by a later invocation using the same agent identity. A stopped parent can be split only with its original overflow fence; a different worker cannot appropriate the split, and running leases are bound to the exact invocation session.
- The independent verifier must differ from both atomiser and executor. Recursively atomised children require their own descendant verification and parent reconciliation before their ancestor may be completed.
- Child verification retains pending status; an unclaimed review marker of verification_claim_expires_at = infinity keeps it out of the legacy global verifier selector. The socket verifier RPC replaces that marker with a finite verification lease.
- Triggers reject legacy claim and verification bypasses and premature parent completion. Negative verification decisions cannot be reused to authorize a successful verdict. Invocation/usage/overflow/provenance records carry explicit version fields.

## Authentication boundary

The trusted service-role control plane registers each invocation in public.socket_invocations after authenticating it externally. Required fields: agent_id; a distinct session_id; attested authenticated_subject; role (worker, atomizer, executor, verifier); and expiry. PostgreSQL generates an opaque ID and secret. Pass those only through a private authenticated channel, never into logs, PRs, browser code, or publicly readable task records.

All RPCs validate ID, secret, role, and expiry. New tables have row-level security enabled with no anon/authenticated permissions. Only the trusted service_role may access invocation records and socket RPCs. The gateway, transport, model metering, and agent dispatch integrations are intentionally external. This database credential boundary is not itself a JWT authentication service.

## Reproduction

Use a dedicated disposable PostgreSQL test database that already has the current ATAX base schema. Run the transaction-scoped integration tests:

    psql "$SOCKET_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/socket-ledger/socket_atomization_integration.sql

This replays the migration twice and rolls back all fixtures and objects. It covers duplicate and contradictory usage replays, input/output/aggregate ceilings, stopped-parent and cross-session fences, scope/usage overflow, author-executor-verifier identity isolation, dependency checks, verified parent finalization, direct promotion after negative verdicts, failed split rollback, recursive decomposition and verified recursive parent completion.

A real two-backend race additionally requires a disposable migrated test database and psql:

    SOCKET_TEST_DATABASE_URL="postgresql://..." SOCKET_TEST_DISPOSABLE=YES bash tests/socket-ledger/concurrent_claims.sh

The race harness launches two independent PostgreSQL client sessions against one child and requires exactly one winner, one rejected claim, and one unchanged exclusive fence. It leaves fixtures in the disposable database, which should be discarded afterwards.

## Evidence and remaining verification

Executed: migration syntax and double replay on the canonical Supabase project vcaerawuwffziufvpbvw inside BEGIN/ROLLBACK. The latest extended SQL regression returned the proof marker full_context_ceiling_and_fenced_lifecycle_passed, including recursive verification, identity separation, replay defenses, and input/output/combined budget thresholds. No live schema changes or fixtures were persisted.

Not executed here: the separate-process claim race, because this execution environment has neither psql nor a disposable PostgreSQL service. A separate independent reviewer must run that harness before certifying cross-connection concurrency.

Not done: live production schema deployment, main merge, or self-verification. The release reconciler owns those steps.

Integration requirement: trusted control-plane registration of separately authenticated invocations, real event-by-event token consumption, and use of the new child claim/verification RPCs. Legacy selectors do not claim the socket-specific waiting/review records.

The canonical task was observed queued with loop_script_status = missing. This agent has not bypassed its independent loop-authoring gate or claimed completion or independent verification in the durable ledger.
