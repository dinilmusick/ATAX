# Typed task execution pipeline (implementation contract)

ATAX remains a durable control plane for externally arriving agents. It never spawns or schedules agents. GitHub Actions executes bounded deterministic operations, not agents. The existing FMRL execution boundary remains mandatory: **never execute target operations in ATAX repository Actions**. A control-plane workflow may provision/dispatch a disposable FMRL runner, which must be deleted after use and independently checked for deletion.

## State machine

- `uninitiated`: intent only, at vision/goal/task levels. This is an initiation dimension, separate from occupancy and verification status.
- `initiated`: decomposition or typed target + input schema + acceptance + verifier plan recorded. Initiator cannot produce input for this same task invocation.
- `input_ready`: distinct agent submits bounded, schema-valid input; no target mutation.
- `dispatch_pending` -> `dispatched` -> `executing` -> `executed` or `failed` / `outcome_unknown`.
- `verification_pending` -> independently `verified` or `rejected`.

No agent may initiate, prepare, or verify the same task in one invocation. An agent may move to unrelated available work.

## Contract

Store immutable versioned operation contract with: operation identifier, endpoint registration reference (never arbitrary user URL), HTTP method, path template, allowed effect class, JSON schema for input, pinned tokenizer version and <=512 input tokens, maximum bytes, credential reference, timeout, retry policy, response bounds, idempotency semantics, target precondition/version, evaluator reference. Input submission records canonical bytes hash, submitter, and version. Credentials are resolved by the trusted runner, never stored in task payloads or logs.

A short payload does **not** bound side effects. Registry operations must explicitly limit destinations and effects. HTTP is restricted to registered HTTPS hosts with DNS/IP egress controls (including redirect and DNS rebinding checks). Never accept arbitrary headers, shell commands, URLs, or code from an agent. Email and other irreversible operations require provider idempotency or explicit outcome reconciliation; never blindly retry an uncertain send.

## Dispatch and durable correctness

A transaction atomically validates task stage, claim fence, schema/token/byte limits and authorization, freezes payload hash, and inserts one unique outbox row keyed by task+revision. A trusted external dispatcher consumes outbox entries, uses GitHub workflow_dispatch for the **FMRL** execution environment, records correlation/run IDs, and retries dispatch only when safe. Supabase triggers do not run remote work. Workflow-dispatch acceptance is not proof of execution. Reconcile GitHub run state and callback evidence.

Runner obtains one short-lived scoped execution ticket, rechecks task revision/fence and contract hash, applies one registry operation, writes sanitized receipt and evidence via guarded RPC. A lease lapse invalidates future ledger writes; irreversible external side effects require provider-level idempotency/reconciliation. Avoid publishing private payloads or credentials in public FMRL repository, workflow inputs, artifacts or logs. Secure payload retrieval occurs inside the transient runner. Always delete FMRL after execution, even on failure.

## Acceptance gates

1. SQL transaction tests: concurrent submissions create exactly one outbox event; stale claims and wrong stage rejected.
2. HTTP adapter tests: schema rejection, token/byte rejection, unregistered endpoint, redirect/private IP, timeout, secret/log sanitization.
3. Dispatch tests: duplicate delivery, workflow failure, lost callback, expired ticket, safe retry, ambiguous external outcome.
4. End-to-end test: initiated -> input_ready -> FMRL execution -> callback -> independent verification -> FMRL deletion verified; no target operations in ATAX Actions.

This document specifies intended behavior, not a claim that these gates have been implemented.
