# ATAX Socket V1 — standalone conformance

Test entry: `node --test tests/task-socket-conformance/*.test.mjs` (Node 20+; Node 22 used in development). No package install, provider keys, Supabase access or other agent branches. Test files and fake interfaces are exclusively in this directory; production code is never imported by default.

Calibration: `node tests/task-socket-conformance/calibration-cli.mjs` shows conservative budgets and explicitly unmeasured reliability. `node tests/task-socket-conformance/calibration-cli.mjs /path/to/observations.json` validates a *real* provider observation record. The committed `fixtures/calibration-synthetic.json` is deliberately **rejected** as live evidence.

Final reconciler can implement an **external adapter shim** exporting `createAdapter(options)` with the versioned interface in `adapter-contract.mjs`; execute `ATAX_SOCKET_CONFORMANCE_ADAPTER=/absolute/path/shim.mjs node --test tests/task-socket-conformance/adapter-contract.test.mjs`. The shim should create disposable fixtures, translate canonical RPC and gateway responses to the stable error codes, enforce teardown, and preserve durable metadata across simulated reconnects. It must not modify or import the fake.

Contract summary: `claim -> bounded pull/push -> stop-on-overflow -> separate planner atomizes -> different agent claims child -> pinned delegated workflow -> independent verification`. Status and meter state are durable per task, never reset by reconnect. Claim identities include principal, task, session, and fence. Every provider and tool accounting increment is cumulative and append-only. Inputs, outputs, retries, failed attempts and repeated chunks count. Direct mutations and raw credentials are forbidden.

See `docs/task-socket-conformance.md` for provider sourcing, calibration methods, expected failures and integrated release gates.
## Agent K hardening

The additional attestation.test.mjs and adapter-adversarial.test.mjs cover untrusted calibration data and independent negative gates. The calibration CLI requires ATAX_SOCKET_TRUST_STORE when an observation JSON is supplied, but remains uncalibrated by default.

    node --test tests/task-socket-conformance/*.test.mjs
    node tests/task-socket-conformance/calibration-cli.mjs
    ATAX_SOCKET_TRUST_STORE=/secure/keys.json node tests/task-socket-conformance/calibration-cli.mjs /secure/observation.json
    ATAX_SOCKET_CONFORMANCE_ADAPTER=/absolute/path/disposable-shim.mjs node --test tests/task-socket-conformance/adapter-contract.test.mjs tests/task-socket-conformance/adapter-adversarial.test.mjs

Tests using the reference fake do not certify live provider access, database, gateway or GitHub execution. See docs/task-socket-conformance.md section 7 for exact trust requirements, red release gates and evidence status.

## Verified native suite and mutation negative gate (Agent K follow-up)

Reproduced with Node 22.16.0 from blob-verified remote sources: `node --test tests/task-socket-conformance/*.test.mjs` => 47 passed, 0 failed. `mutation-sensitivity.test.mjs` verifies that an intentionally defective `fixtures/faulty-adapter.mjs` (meter reset and direct-target write bypass) fails both adapter test files with explicit failures. The synthetic and forged provider observation fixtures remain invalid as live evidence.

`gpt-5.4-nano` was re-audited: it has published 400,000 context and 128,000 maximum output tokens but is deprecated with an announced 2027-04-01 shutdown; its OpenAI API Free tier is explicitly unsupported. This affects eligibility, not the mathematical capacity bound. The complete native mock suite is not a live production-integrated certificate; the independent final reconciler must still execute real disposable A-D, GitHub, database and provider gates.
