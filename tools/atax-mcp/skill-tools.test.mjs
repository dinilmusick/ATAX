import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TOOLS } from './worker.mjs';

const owner = {id: 'owner', authMethod: 'shared'};
const find = name => TOOLS.find(tool => tool.name === name);
const invoke = (name, args = {}, db = {rpc: async () => null}, fetcher = async () => Response.json([])) =>
  find(name).invoke(args, db, owner, {env: {}, fetcher});

const sha256 = text => createHash('sha256').update(text).digest('hex');
const REVISION = 'a'.repeat(40);

test('executable skill MCP tools are exposed',()=>{
  const names=new Set(TOOLS.map(tool=>tool.name));
  for(const name of ['atax_skill_executable_spec','atax_skill_register','atax_skill_import_github']) assert.equal(names.has(name),true);
});

test('atax_skill_executable_spec calls the canonical executable spec RPC', async () => {
  const seen = [];
  const db = {rpc: async (name, params) => {seen.push({name, params}); return {slug: 'demo', command: 'node index.js'};}};
  const spec = await invoke('atax_skill_executable_spec', {slug: 'demo'}, db);
  assert.deepEqual(seen, [{name: 'atax_mcp_skill_executable_spec_v2', params: {slug_in: 'demo'}}]);
  assert.equal(spec.command, 'node index.js');
});

test('atax_skill_register validates slug, hashes assets and calls the register RPC', async () => {
  const seen = [];
  const db = {rpc: async (name, params) => {seen.push({name, params}); return {slug: 'demo', status: 'published'};}};
  const result = await invoke('atax_skill_register', {
    name: 'Demo', slug: 'demo', instructions: '# Demo', version: '1.1.0',
    assets: [{path: 'scripts/run.mjs', content: 'console.log(1);\n'}],
  }, db);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'atax_mcp_skill_register_v1');
  const payload = seen[0].params.payload;
  assert.equal(payload.slug, 'demo');
  assert.equal(payload.version, '1.1.0');
  assert.equal(payload.assets[0].path, 'scripts/run.mjs');
  assert.equal(payload.assets[0].source_sha256, sha256('console.log(1);\n'));
  assert.equal(result.status, 'published');
  await assert.rejects(invoke('atax_skill_register', {name: 'Demo', slug: 'Bad Slug', instructions: 'x'}, db), /Invalid skill slug/);
  await assert.rejects(invoke('atax_skill_register', {name: 'Demo', slug: 'demo', instructions: 'x', assets: [{path: '../escape.mjs', content: 'x'}]}, db), /Invalid skill asset path/);
});

test('atax_skill_import_github fetches immutable assets and registers provenance', async () => {
  const seen = [];
  const db = {rpc: async (name, params) => {seen.push({name, params}); return {slug: 'imported', status: 'published'};}};
  const fetcher = async url => {
    if (url === `https://raw.githubusercontent.com/owner/repo/${REVISION}/SKILL.md`) return new Response('# Imported skill\n');
    if (url === `https://raw.githubusercontent.com/owner/repo/${REVISION}/scripts/run.mjs`) return new Response('export const x = 1;\n');
    throw new Error('Unexpected URL ' + url);
  };
  const result = await invoke('atax_skill_import_github', {
    repository: 'owner/repo', revision: REVISION, name: 'Imported', slug: 'imported',
    asset_paths: [{path: 'scripts/run.mjs', executable: true}],
  }, db, fetcher);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'atax_mcp_skill_register_v1');
  const payload = seen[0].params.payload;
  assert.equal(payload.instructions, '# Imported skill\n');
  assert.equal(payload.version, '1.0.0');
  assert.equal(payload.source.source_type, 'github');
  assert.equal(payload.source.repository, 'owner/repo');
  assert.equal(payload.source.owner, 'owner');
  assert.equal(payload.source.uri, `https://github.com/owner/repo/tree/${REVISION}/SKILL.md`);
  assert.equal(payload.metadata.immutable_revision, REVISION);
  assert.equal(payload.assets.length, 2);
  assert.equal(payload.assets[0].asset_type, 'instruction');
  assert.equal(payload.assets[1].executable, true);
  assert.equal(payload.assets[1].source_sha256, sha256('export const x = 1;\n'));
  assert.equal(result.status, 'published');
  await assert.rejects(
    invoke('atax_skill_import_github', {repository: 'owner/repo', revision: 'main', name: 'X', slug: 'x'}, db, fetcher),
    /immutable 40-character commit SHA/
  );
  await assert.rejects(
    invoke('atax_skill_import_github', {repository: 'owner bad name', revision: REVISION, name: 'X', slug: 'x'}, db, fetcher),
    /Invalid GitHub repository/
  );
  await assert.rejects(
    invoke('atax_skill_import_github', {repository: 'owner/repo', revision: REVISION, name: 'X', slug: 'x'}, db, async () => new Response(null, {status: 404})),
    /Unable to fetch GitHub skill asset/
  );
});
