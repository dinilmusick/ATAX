import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { MockSocket } from './mock-socket.mjs';
import { registerAdapterConformance } from './adapter-contract.mjs';

// Set ATAX_SOCKET_CONFORMANCE_ADAPTER=relative-or-absolute-shim.mjs to run
// the exact same contract tests against an integrated Agent A-D adapter.
// The default uses only local mocks and runs with no credentials/network.
const external = process.env.ATAX_SOCKET_CONFORMANCE_ADAPTER;
const factory = external
  ? (await import(pathToFileURL(resolve(external)).href)).createAdapter
  : options => new MockSocket(options);
if (typeof factory !== 'function') throw new Error('Adapter module must export createAdapter(options)');
registerAdapterConformance(factory, external ? 'integrated-socket' : 'standalone-mock');