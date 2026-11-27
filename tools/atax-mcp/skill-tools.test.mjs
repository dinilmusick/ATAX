import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOLS} from './worker.mjs';

test('executable skill MCP tools are exposed',()=>{
  const names=new Set(TOOLS.map(tool=>tool.name));
  assert.equal(names.has('atax_skill_executable_spec'),true);
  assert.equal(names.has('atax_skill_register'),true);
  for(const name of ['atax_skill_executable_spec','atax_skill_register']){
    const tool=TOOLS.find(item=>item.name===name);
    assert.ok(tool?.inputSchema);
  }
});
