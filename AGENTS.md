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

**This bootstrap is unconditional.** At the moment an agent/session comes into play, before interpreting, classifying, answering, or acting on the incoming turn, hydrate the live Supabase substrate and canonical skill catalogue. This applies to **every turn**, including greetings, casual conversation, clarifications, questions, acknowledgements, and requests that appear purely conversational.

The agent must not decide that a turn is “conversation-only” before this bootstrap. Conversation is a response modality, not an exemption from substrate hydration.

At session entry, orient from `agent_context_overview()` and the global goal/task overview when those canonical operations are available. For every turn, check current persisted work/context before deciding whether to respond conversationally or perform work. For work/context/continuation/self-improvement/project-state requests, hydrate the full current universe/system/goal/task/maintenance context, including deadlines, dependencies, blockers and available execution tooling. When asked what remains or what to work on, use global persisted state rather than chat history, then select eligible work through the atomic claim path. Never ask the user to inspect the ledger when the connected substrate can do so.