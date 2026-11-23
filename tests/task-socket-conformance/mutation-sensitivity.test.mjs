import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const broken = join(dir, 'fixtures/faulty-adapter.mjs');
for (const spec of [
  { file: 'adapter-contract.test.mjs', required: ['metering is cumulative', 'direct target mutation is rejected'] },
  { file: 'adapter-adversarial.test.mjs', required: ['mixed input/output/retry consumption', 'direct writes, credentials and unrestricted APIs'] },
]) {
  test(`adapter contract detects deliberately broken behavior in ${spec.file}`, () => {
    const env = { ...process.env, ATAX_SOCKET_CONFORMANCE_ADAPTER: broken };
    // Node's test runner injects a recursive-test sentinel into subprocesses.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(dir, spec.file)], {
      env,
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, 'unsafe adapter must fail the contract');
    const transcript = (result.stdout ?? '') + (result.stderr ?? '');
    for (const name of spec.required) {
      assert.match(transcript, new RegExp('not ok.*' + name.replaceAll('/', '\\/')),
        `mandatory security negative was not detected: ${name}`);
    }
    assert.match(transcript, /fail [1-9]/, 'TAP must record a genuine nonzero failed-test count');
  });
}
