# ATAX Socket V1 — standalone conformance

Test entry: `node --test tests/task-socket-conformance/*.test.mjs` (Node 20+; Node 22 used in development). No package install, provider keys, Supabase access or other agent branches. Test files and fake interfaces are exclusively in this directory; production code is never imported by default.

Calibration: `node tests/task-socket-conformance/calibration-cli.mjs` shows conservative budgets and explicitly unmeasured reliability. `node tests/task-socket-conformance/calibration-cli.mjs /path/to/observations.json` validates a *real* provider observation record. The committed `fixtures/calibration-synthetic.json` is deliberately **rejected** as live evidence.

Final reconciler can implement an **external adapter shim** exporting `createAdapter(options)` with the versioned interface in `adapter-contract.mjs`; execute `ATAX_SOCKET_CONFORMANCE_ADAPTER=/absolute/path/shim.mjs node --test tests/task-socket-conformance/adapter-contract.test.mjs`. The shim should create disposable fixtures, translate canonical RPC and gateway responses to the stable error codes, enforce teardown, and preserve durable metadata across simulated reconnects. It must not modify or import the fake.

Contract summary: `claim -> bounded pull/push -> stop-on-overflow -> separate planner atomizes -> different agent claims child -> pinned delegated workflow -> independent verification`. Status and meter state are durable per task, never reset by reconnect. Claim identities include principal, task, session, and fence. Every provider and tool accounting increment is cumulative and append-only. Inputs, outputs, retries, failed attempts and repeated chunks count. Direct mutations and raw credentials are forbidden.

See `docs/task-socket-conformance.md` for provider sourcing, calibration methods, expected failures and integrated release gates.