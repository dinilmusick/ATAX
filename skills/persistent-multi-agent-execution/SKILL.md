---
name: "Persistent Multi-Agent Execution"
slug: persistent-multi-agent-execution
version: 1.3.0
source: Supabase Skills Database
sourceId: 46
status: active
---

# Persistent Multi-Agent Execution

Use for durable execution where ChatGPT agents may pause, disappear, or lose conversational continuity.

## Canonical boundary

Supabase = durable goals/tasks/dependencies/leases/evidence. GitHub Issue = coding execution state. PR = implementation artifact. CI = verification evidence.

## Transient-agent invariant

Agents are spawned externally by the ChatGPT interface. ATAX does not spawn or schedule agents. An incoming agent reconstructs context from the substrate, executes finite work, persists evidence/state, verifies, then may leave. Continuity comes from persistent state, not resident agents.

## Worker

Load complete task context before acting. Persist status, current work, next action, blockers, evidence and resume point. Claim atomically; heartbeat about every 2 minutes; check ownership about every 5 minutes; stale recovery requires >=5 minutes without heartbeat. If ownership is lost, stop. Never keep essential state only in chat.

## Always-Available Work

When no executable finite ledger task exists, the incoming agent must discover applicable Always-Available Work rather than idle:
- constraint-enforcement
- goal-implementation-push
- system-health-check
- system-optimization

These modalities produce finite work units. Constraint work is detect -> observe -> remediate -> independently verify -> recheck. Goal push measures implementation gap and advances until acceptance is actually satisfied.

## Verification

Completion requires persisted evidence and independent verification. Started/pollable operations must be waited on and verified. If substrate behavior changes, update the canonical Supabase skill and this repository copy.

## Coding

One independent coding task -> one Issue -> one dedicated PR. Preserve blockers, decisions and resume state in the Issue.
