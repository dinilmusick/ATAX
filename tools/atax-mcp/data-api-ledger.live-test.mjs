// Runs only against isolated local Supabase created by database-integration.yml.
// No remote credentials or production effects. Read-only PostgREST RPC contract tests.
import assert from 'node:assert/strict';
import { createLedgerDb } from './data-api-ledger.mjs';

const baseUrl = process.env.ATAX_SUPABASE_URL || process.env.SUPABASE_URL;
const apiKey = process.env.ATAX_SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!baseUrl || !(baseUrl.startsWith('http://127.0.0.1:') || baseUrl.startsWith('http://localhost:'))) {
  throw Error('Disposable local Supabase Data API URL (127.0.0.1 / localhost) required');
}
if (!apiKey) {
  throw Error('Disposable local Supabase service key required');
}

const db = createLedgerDb({ baseUrl: baseUrl.replace(/\/+$/, ''), apiKey });

const overview = await db.rpc('goal_ledger_overview', { tags_in: null });
assert.ok(overview !== undefined, 'migrated canonical goal overview must resolve');

const policy = await db.rpc('atax_mcp_runtime_config_v1', {});
assert.ok(policy && typeof policy.settings === 'object');
assert.ok(Array.isArray(policy.accounts));

const socket = await db.rpc('atax_mcp_socket_config_v1', {});
assert.ok(socket && typeof socket === 'object');
assert.ok(!Object.hasOwn(socket, 'accounts'));

const search = await db.skills('synthetic-nonexistent-slug');
assert.ok(Array.isArray(search), 'skills search must be an array');

const catalog = await db.request('skills?select=id,name');
assert.ok(Array.isArray(catalog), 'published skills catalog must be array');

const tagged = await db.rpc('goal_ledger_overview', { tags_in: ['test-nonmatching'] });
assert.ok(tagged !== undefined);

await assert.rejects(
  db.rpc('goal_ledger_get_by_key', { goal_key_in: 'mcp-nonexistent-goal' }),
  err => err?.name === 'LedgerError' && err?.status === 404
);

console.log('ATAX Supabase Data API PostgREST RPC and restricted config smoke passed');
