// Runs only against isolated local Supabase created by database-integration.yml.
// No remote credentials or production effects. Read-only RPC contract tests.
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {createLedgerDb} from './pg-ledger.mjs';

const url=process.env.DATABASE_URL;
if(!url||!url.includes('@127.0.0.1:54322/'))throw Error('Disposable PostgreSQL required');
const sql=postgres(url,{max:1,prepare:false});
try {
  const db=createLedgerDb(sql);
  const overview=await db.rpc('goal_ledger_overview',{tags_in:null});
  assert.ok(overview!==undefined,'migrated canonical goal overview must resolve');
  const policy=await db.rpc('atax_mcp_runtime_config_v1',{});
  assert.ok(policy&&typeof policy.settings==='object');
  assert.ok(Array.isArray(policy.accounts));
  const socket=await db.rpc('atax_mcp_socket_config_v1',{});
  assert.ok(socket&&typeof socket==='object');
  assert.ok(!Object.hasOwn(socket,'accounts'));
  const search=await db.skills('synthetic-nonexistent-slug');
  assert.ok(Array.isArray(search),'skills search must be an array');
  const catalog=await db.request('skills?select=id,name');
  assert.ok(Array.isArray(catalog),'published skills catalog must be array');
  const tagged=await db.rpc('goal_ledger_overview',{tags_in:['test-nonmatching']});
  assert.ok(tagged!==undefined);
  const missing=await db.rpc('goal_ledger_get_by_key',{goal_key_in:'mcp-nonexistent-goal'});
  assert.ok(missing===null||typeof missing==='object');
  console.log('ATAX direct PostgreSQL RPC and restricted config smoke passed');
} finally {
  await sql.end({timeout:3});
}
