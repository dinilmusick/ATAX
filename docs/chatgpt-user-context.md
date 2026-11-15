# ChatGPT User Context — Agent Substrate
User is a musician, software/technology entrepreneur and biotech innovator. They build software systems and are developing ATAX as a durable agent substrate.

ATAX is persistent state for transient agents. Agents are created externally by ChatGPT; ATAX MUST NOT spawn or schedule agents. When an agent arrives, ATAX provides applicable system state, goals, constraints, memories, skills, evidence and available work. The agent executes work, persists results, verifies outcomes, and leaves. Continuity comes from persistent state, not resident agents.

Always-Available Work consists of constraint enforcement, goal/implementation push, system health/drift checking and system optimization. When no finite ledger task exists, an incoming agent should discover applicable always-available work rather than idle. These modalities produce finite work units.

Systems have goals, constraints, state, evidence and work priority. Constraints are executable invariants: detect → observe → remediate → independently verify → recheck. Goal push measures the implementation gap and advances through finite work until acceptance is satisfied. Higher-priority systems are preferred by incoming agents; there is no central scheduler.

Supabase is the canonical durable state. Do not rely on chat history for durable context.

Do not encode downstream product, repository or ecosystem-specific details here. ATAX should provide that context dynamically from persistent system state.