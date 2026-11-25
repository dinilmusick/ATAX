// Runs only against the isolated local Supabase created by database-integration.yml.
// No remote credentials or production effects. PostgreSQL canonical RPC contract tests.
import assert from 'node:assert/strict';
import { createLedgerDb } from './data-api-ledger.mjs';

const connectionString = process.env.ATAX_SUPABASE_CONNECTION_URL;
if (!connectionString || !connectionString.startsWith('postgresql://127.0.0.1:') && !connectionString.startsWith('postgresql://postgres:postgres@127.0.0.1:')) {
  throw Error('Disposable local PostgreSQL connection URI required');
}

const db = createLedgerDb({connectionString,hostLabel:'127.0.0.1'});

const overview = await db.rpc('goal_ledger_overview', { tags_in: null });
assert.ok(overview !== undefined, 'migrated canonical goal overview must resolve');

const policy = await db.rpc('atax_mcp_runtime_config_v1', {});
assert.ok(policy && typeof policy.settings === 'object');
assert.ok(Array.isArray(policy.accounts));

const socket = await db.rpc('atax_mcp_socket_config_v1', {});
assert.ok(socket && typeof socket === 'object');
assert.ok(!Object.hasOwn(socket, 'accounts'));

const authStatus = await db.rpc('atax_mcp_instance_auth_status_v1', {});
assert.equal(Boolean(authStatus?.passkeyConfigured), false, 'fresh disposable database must not have a configured instance passkey');

const search = await db.skills('synthetic-nonexistent-slug');
assert.ok(Array.isArray(search), 'skills search must be an array');

const catalog = await db.skillsCatalog();
assert.ok(Array.isArray(catalog), 'published skills catalog must be an array');

const tagged = await db.rpc('goal_ledger_overview', { tags_in: ['test-nonmatching'] });
assert.ok(tagged !== undefined);

await assert.rejects(
  db.rpc('goal_ledger_get_by_key', { goal_key_in: 'mcp-nonexistent-goal' }),
  err => err?.name === 'LedgerError' && err?.status === 404
);

console.log('ATAX disposable Supabase PostgreSQL RPC and restricted configuration smoke passed');
