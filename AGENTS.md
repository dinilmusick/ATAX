# ATAX Agent Workspace

The two root ChatGPT context files are the stable entry contract:

- `AGENT_INSTRUCTIONS.md` — canonical compact agent operating contract.
- `CHATGPT_USER_CONTEXT.md` — canonical stable user + ATAX context.

## Authority hierarchy

1. **Supabase** — canonical durable state: systems, goals, tasks, dependencies, constraints, memories, skills, evidence and work.
2. **Loaded canonical Supabase skills** — detailed procedures for the current operation.
3. **Root ChatGPT files** — stable entry context only.
4. **Other repository documentation** — supporting implementation documentation, not a replacement for live substrate state.

ATAX does not spawn or schedule agents. Agents are created externally. An incoming agent loads applicable state and skills, executes finite work, persists evidence, independently verifies, and leaves.

Do not encode current downstream product/ecosystem architecture in the root ChatGPT context. Resolve it from the live substrate.

Do not treat chat history as durable state.

When a detailed skill or repository document conflicts with the stable ATAX contract above, treat the conflict as repository drift and reconcile it rather than silently inventing a new rule.

## Mandatory live-substrate bootstrap

A newly spawned agent has no reliable conversational history. Before substantive work or project-state reasoning, inspect the live Supabase substrate and canonical skill catalogue. For work/context/continuation/self-improvement/project-state requests, hydrate the current universe/system/goal/task/maintenance context, including deadlines, dependencies, blockers and available execution tooling.

At session entry, orient from `agent_context_overview()` and the global goal/task overview when those canonical operations are available. When asked what remains or what to work on, use global persisted state rather than chat history, then select eligible work through the atomic claim path. Never ask the user to inspect the ledger when the connected substrate can do so.