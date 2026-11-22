# ATAX ATAX

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

## Three supported connections, one canonical substrate

ATAX's interface is independent of the agent and the AI application. See [connection modes](docs/connection-modes.md).

- **GitHub connector only:** agents use this repository's instructions, tools and trusted GitHub workflows. Live Supabase ledger operations require a separately authorized credential-bearing client/bridge, not bare repository access; A [private GitHub controller bridge](tools/github-only-ledger-bridge/README.md) is implemented but requires separately configured secrets, access, and live certification; full bridge parity remains to be verified.
- **GitHub + Supabase connectors:** existing direct-connector path reads/writes live state through the connected Supabase RPC tools and operates GitHub through its connector; **do not redirect it through MCP**.
- **Remote ATAX MCP:** authenticated clients use the owner-configured Cloudflare Worker `/mcp` endpoint, whose bounded tools call the **same** ledger RPCs. Worker credentials are Cloudflare secrets, independent from GitHub Actions repository secrets.

**In every mode:** incoming agents are created externally; ATAX does not know/care which model/application arrived. A task is a **socket** occupied by one valid atomic claim and fencing token at a time. All entrants must use canonical Supabase claim, heartbeat, submit, release and independent verification safeguards. GitHub Issues, workflow statuses, an MCP session and chat history are **not** substitute locks or canonical state. Do not claim full three-mode equivalence until live acceptance tests prove it.

## Mandatory live-substrate bootstrap

**This bootstrap is unconditional.** At the moment an agent/session comes into play, before interpreting, classifying, answering, or acting on the incoming turn, hydrate the live Supabase substrate and canonical skill catalogue. This applies to **every turn**, including greetings, casual conversation, clarifications, questions, acknowledgements, and requests that appear purely conversational.

The agent must not decide that a turn is “conversation-only” before this bootstrap. Conversation is a response modality, not an exemption from substrate hydration.

At session entry, orient from `agent_context_overview()` and the global goal/task overview when those canonical operations are available. For every turn, check current persisted work/context before deciding whether to respond conversationally or perform work. For work/context/continuation/self-improvement/project-state requests, hydrate the full current universe/system/goal/task/maintenance context, including deadlines, dependencies, blockers and available execution tooling. When asked what remains or what to work on, use global persisted state rather than chat history, then select eligible work through the atomic claim path. Never ask the user to inspect the ledger when the connected substrate can do so.

## Mandatory FMRL execution boundary

ATAX is **only the control plane and tool source**, never a checkout workspace or GitHub Actions runner for target code. No target/private checkout, installation, build, test, `act` invocation, or coding commands may run in `dinilmusick/ATAX` Actions. The historical ATAX-as-workspace and Agent-Workspace-1 patterns are forbidden.

Execution priority:
1. Use the agent's own container/runtime; clone the **target repository** directly there (if authorized), edit and test locally. ATAX tools may be downloaded as tooling, but the ATAX repository must not become the target checkout or runner.
2. If local execution is unavailable, inaccessible, insufficient, or remote public Actions evidence is required, provision an **FMRL-prefixed, one-job disposable public repository** through `tools/github/disposable_workspace.py` or ATAX's control-plane workflow. This is the **only** remote GitHub compute location for private targets.
3. The FMRL public repository contains only bridge workflow code. Authorized private source is checked out **only inside its transient runner** and never pushed, artifacted, cached, or committed to the public repository. The checkout token is used only by the clone step; target commands receive no repository token.
4. Run and inspect checks, record evidence, obtain independent verification, **delete FMRL**, and independently confirm the repository returns 404. Deletion is mandatory on failure as well as success; failed cleanup is a blocker, not completion.
5. If FMRL cannot be provisioned, report the blocker and preserve work in the ledger. **Never fall back to ATAX or private-repository Actions execution.**

A new permanent repository (plain or Skipo) is a different lifecycle from disposable FMRL compute. Keep the two workflows separate.