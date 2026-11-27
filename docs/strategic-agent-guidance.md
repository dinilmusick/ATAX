# ATAX strategic orientation and preemptive guidance

ATAX is a durable strategic substrate for externally created, transient agents. The canonical planning graph is:

System → Subsystem → Vision → Target → Goal → Task → evidence → independent verification.

## Agent workflow

For a substantive request:

1. Hydrate current ATAX context and the narrowest applicable skills.
2. Resolve the existing System and strategic graph.
3. Reuse the existing Vision/Goal when the request belongs to it. Create only missing strategic structure.
4. Decompose substantive goals into bounded tasks with 1–4 actions, dependencies, acceptance criteria and verification.
5. Claim one eligible task, execute externally, persist evidence and obtain independent verification.
6. Reassess the graph after material state changes.

ATAX does not spawn or schedule agents. The incoming agent performs execution; ATAX persists and governs the state.

## Progressive/preemptive guidance

ATAX adopts the useful DeaTS pattern of **stateful, on-demand guidance**.

Tool calls update a durable guidance record. Ordinary tool responses do **not** include the guidance payload. They return only a compact indication that current guidance is available.

When the next strategic move is unclear, call `atax_preemptive_guidance_get` or read resource `atax://guidance/preemptive`.

The returned guidance contains the current strategic principles, suggested next steps and a current canonical briefing. This keeps repeated tool calls from filling the model context with the same planning documentation.

The static orientation is available through `atax_intro_documentation`, resource `atax://documentation/intro`, MCP server initialization instructions, and the `atax-introduction` prompt.

## Private-repository CI

For remote CI/build/test evidence on private repositories, prefer **ATAX FMRL**. FMRL provisions a disposable public bridge, checks out the exact private commit only inside its isolated runner, runs the requested checks, and deletes the bridge.

Use `atax_fmrl_create_run_dispose`, then poll `atax_fmrl_get_status` until both execution and independent cleanup verification are complete.

Do not dispatch the target private repository's GitHub Actions merely because it is available. That consumes the target repository's private GitHub Actions quota and defeats the FMRL isolation policy.

Local/container execution remains appropriate for development and local checks. ATAX itself is never a target checkout or execution workspace.

## Design principle

**Update the agent's map; do not repeatedly push the map into the agent's context.**

The graph and verified evidence remain canonical. Preemptive guidance is derived navigational state.
