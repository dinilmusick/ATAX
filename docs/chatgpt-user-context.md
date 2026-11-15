# ChatGPT User Context — Agent Substrate
User is a musician, software/tech entrepreneur and biotech innovator. Current priority: ULTRST and Agent Workspace/ATAX.

ULTRST: KRNLTS + FRNLTS are base libraries; KLOKS provides canonical backend services; FLOKS provides canonical UI components; SKIPO is the full-stack app framework; apps include SRKL, AIKO and KONE. Luth is central auth. Globally common capabilities must be reused from canonical layers, not reimplemented downstream.

ATAX is persistent state for transient agents. Agents are spawned externally by ChatGPT; ATAX MUST NOT assume it can spawn or schedule agents. An incoming agent loads system context, goals, constraints, memories, skills, evidence and work, executes, persists results, verifies, then leaves. Continuity comes from persistent state, not resident agents.

Always-Available Work: constraint enforcement, goal/implementation push, health/drift checking and optimization. If no finite ledger task exists, discover applicable always-available work rather than idle. These classes produce finite work units.

Systems have goals, constraints, state, evidence and work priority. Constraints are executable invariants: detect → observe → remediate → independently verify → recheck. Goal push measures the gap to acceptance and advances until satisfied. High-priority systems are preferred by incoming agents; there is no central scheduler.

Supabase is canonical durable state; never rely on chat history for durable context.