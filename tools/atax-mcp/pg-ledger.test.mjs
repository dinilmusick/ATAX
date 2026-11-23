import test from 'node:test';
import assert from 'node:assert/strict';
import {parseConnectionUri,createLedgerDb,openLedger} from './pg-ledger.mjs';

const URI='postgresql://restricted_user:synthetic_password@db.project.supabase.co:5432/postgres?sslmode=require';
test('one TLS Supabase PostgreSQL connection URI is mandatory',()=>{
  assert.equal(parseConnectionUri({ATAX_SUPABASE_CONNECTION_URL:URI}),URI);
  for(const value of ['', 'https://project.supabase.co',
    URI.replace('postgresql:','http:'),
    URI.replace('sslmode=require','sslmode=disable'),
    URI.replace('db.project.supabase.co','evil.example'),
    URI.replace('restricted_user:synthetic_password@',''),
    URI+'&other=1'
  ])assert.throws(()=>parseConnectionUri({ATAX_SUPABASE_CONNECTION_URL:value}));
});

test('named RPC parameters are positional SQL values, not interpolated strings',async()=>{
  const calls=[];
  const sql={unsafe:async(query,values)=>{
    calls.push({query,values});
    if(query.includes('pg_catalog.pg_proc'))return [{is_set:false,kind:'b'}];
    return [{value:{ok:true}}];
  }};
  const db=createLedgerDb(sql);
  const args={name_in:"x') OR 1=1 --",tags_in:['ab"c','d'],
    metadata_in:{status:'safe'}};
  assert.deepEqual(await db.rpc('atax_mcp_runtime_config_v1',args),{ok:true});
  const write=calls.at(-1);
  assert.match(write.query,/name_in => \$1/);
  assert.match(write.query,/tags_in => \$2/);
  assert.ok(!write.query.includes('OR 1=1'));
  assert.equal(write.values[0],args.name_in);
  assert.ok(write.values[1].startsWith('{"'));
  assert.equal(write.values[2],JSON.stringify(args.metadata_in));
  await assert.rejects(db.rpc('evil;DROP TABLE',{}));
});

test('record and set-returning RPCs preserve Supabase REST-compatible JSON shapes',async()=>{
  const calls=[];
  const sql={unsafe:async(query,values)=>{
    calls.push(query);
    if(query.includes('pg_catalog.pg_proc'))
      return [{is_set:values[0]==='task_ledger_claim_next',kind:'c'}];
    return [{value:query.includes('jsonb_agg')?[{id:1}]:{id:2}}];
  }};
  const db=createLedgerDb(sql);
  assert.deepEqual(await db.rpc('task_ledger_claim_next',{}),[{id:1}]);
  assert.deepEqual(await db.rpc('goal_ledger_get_by_key',{goal_key_in:'x'}),{id:2});
  assert.ok(calls.some(q=>q.includes('to_jsonb(t)')));
});

test('injected PostgreSQL transport uses one URL, without provider or API-key bindings',async()=>{
  const db=await openLedger({ATAX_SUPABASE_CONNECTION_URL:URI,GH_KEY_LEGACY:'ignored'},
    async uri=>{
      assert.equal(uri,URI);
      return {unsafe:async q=>q.includes('pg_catalog.pg_proc')?
        [{is_set:false,kind:'b'}]:[{value:{ok:true}}]};
    });
  assert.deepEqual(await db.rpc('agent_context_overview',{}),{ok:true});
});
