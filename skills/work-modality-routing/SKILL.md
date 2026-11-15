---
name: "Work Modality Routing"
slug: work-modality-routing
version: 2.3.0
source: Supabase Skills Database
sourceId: 47
status: active
---

# Work Modality Routing

Route WORK_RESPONSE after Universal Task Router classification.

## Mandatory entry invariant

Ledger/substrate hydration is unconditional. Before interpreting or classifying any incoming turn, including conversational language, the agent must load the current Supabase context and canonical skills. A turn that appears conversational is not an exemption. Never classify a turn as conversation-only before the ledger check.

## Contract

WORK_RESPONSE -> DIRECT_TASK | WORK_MODALITY.
Work types: EXECUTE | GENESIS | CONTRACT | MODIFY | MEMORY | SELF_IMPROVEMENT | INTEGRATE.

Resolve/reuse System -> Universe -> Goal -> 1-4 action Tasks -> persist dependencies/acceptance/verification -> claim -> execute -> evidence -> independent verification -> finalize.

The database work-modality catalogue is authoritative. Never invent a modality.

## Transient-agent substrate

Agents are spawned externally by ChatGPT. ATAX never spawns or schedules agents. Incoming agents, after mandatory hydration, load system context, goals, constraints, memories, skills, evidence and work, execute, persist and verify, then leave.

## Always-Available Work

If no finite ledger task is executable, do not idle. Discover applicable:
- constraint-enforcement
- goal-implementation-push
- system-health-check
- system-optimization

These produce finite work units. Constraint enforcement: detect -> observe -> remediate -> independently verify -> recheck. Goal push: measure implementation gap -> perform finite work -> verify -> repeat until acceptance.

## Priority

System work_priority guides incoming-agent selection. Critical constraint violations may override ordinary priority. There is no central scheduler.

## Persistence

Record work request/modality, resolved System/Goal/Task, agent/session and status in the substrate. Chat history is not durable state.