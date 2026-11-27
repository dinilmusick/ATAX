# WorkSocket unified-principal execution

## Decision

ATAX no longer requires a distinct worker identity from the orchestrator or goal creator. An authenticated ATAX caller may perform any eligible WorkSocket lifecycle role when it has the required tool scope.

Agent / actor identity is retained only as audit attribution and optional routing metadata. It is not a privilege boundary, task-eligibility rule, or reason to reject execution.

## Authority model

```text
authenticated MCP caller + required tool scope
  -> goal / System / resource scope
  -> eligible task
  -> atomic claim + opaque fencing token + expiring lease
  -> bounded context / capability / tool / budget checks
  -> execution / atomisation / child execution
  -> evidence and deterministic acceptance predicates
  -> verification / finalization / append-only audit
```

The claim token and live lease are the execution capability. Every mutation remains bound to the task and current generation/fence. Old tokens, expired leases, duplicate/replayed mutations, terminal tasks, out-of-scope resources and exceeded budgets remain rejected.

## Identity policy to remove

Remove identity-difference requirements from:
- goal creator versus worker claim;
- loop-contract author versus executor;
- atomizer versus child executor;
- atomizer/executor versus verifier;
- task submitter versus verifier;
- parent finalizer versus atomizer / descendant executors.

No API should mint or require a second artificial worker identity to make these paths usable.

## Independent correctness without identity separation

Verification is evidence-based. The system must require the configured acceptance predicates and verifiable evidence: exact source commit, test results, security regression results, artifact hashes, CI run identity and terminal status as relevant. An actor may submit its own result; success is not accepted merely because it self-attests. Automated checks and independent CI/evidence evaluation are the correctness gates.

## Reuse map

| Existing mechanism | Action |
| --- | --- |
| `goal_ledger_claim_task` | Keep atomic eligibility, lease and fence; remove only creator/worker identity inequality |
| `atax_goal_claim_safe` | Keep loop readiness checks; remove author/executor identity inequality |
| `task_ledger_claim_next` | Keep deterministic selection and claim; remove author/executor identity inequality |
| `task_ledger_submit_result` / verification | Keep evidence + acceptance checks; remove actor-identity separation |
| `socket_invocations` and socket gateway | Keep authenticated MCP scope, invocation secret, task fence, context/budget/tool scopes; treat agent/subject fields as audit attribution, not role separation |
| atomisation child claim / verification / parent finalization | Keep child linkage, attenuation, evidence and fences; remove identity mismatch predicates |
| MCP adapters | Derive audit actor from the authenticated principal; do not synthesize or require a different worker ID |

## Implementation and proof plan

1. Inspect every live claim, verification, socket invocation, atomisation and transition function; identify every identity-based rejection predicate and its callers.
2. Add forward-only database migrations and adversarial SQL tests for creator self-claim, same-actor loop execution, atomization, child execution, verification and stale-fence rejection.
3. Update MCP declarations/adapters and tests so every authenticated principal uses the same canonical claim path. Do not add caller-supplied identity overrides.
4. Reconcile UI/intelligence routing: intelligence is a suitability signal only; actor labels never authorize or deny work.
5. Run isolated database integration, MCP/unit tests, security checks and exact PR-head CI. Independently inspect the migration and proof artifacts.

## Status

Design checkpoint only. Implementation, migration tests, UI work, independent verification and CI are pending.
