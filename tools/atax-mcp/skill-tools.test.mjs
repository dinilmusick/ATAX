import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from './worker.mjs';

test('executable skill MCP tools are exposed',()=>{
  const names=new Set(TOOLS.map(tool=>tool.name));
  for(const name of ['atax_skill_executable_spec','atax_skill_register']) assert.equal(names.has(name),true);
  assert.equal(names.has('atax_skill_import_github'),false);
});
