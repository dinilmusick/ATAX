import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillService } from './skills.ts';

const env = { ATAX_SUPABASE_URL: 'https://example.supabase.co', ATAX_SUPABASE_SECRET_KEY: 'test', ATAX_MCP_SHARED_TOKEN: 'token' };

test('skill service rejects mutable GitHub refs before fetching', async () => {
  const service = createSkillService(env, (async () => new Response('{}')) as typeof fetch);
  await assert.rejects(
    service.importGithub({
      repository: 'backnotprop/pstack',
      revision: 'main',
      name: 'P-Stack Interrogate',
      slug: 'pstack-interrogate',
    }),
    /immutable 40-character commit SHA/
  );
});

test('skill service imports an immutable GitHub skill and preserves source assets', async () => {
  const sha = 'a'.repeat(40);
  const calls: Array<{ url: string; body?: string }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    if (url.includes('raw.githubusercontent.com')) {
      return new Response('---\nname: interrogate\ndescription: adversarial review\n---\nReview the change and prove findings with real runs.');
    }
    return new Response(JSON.stringify({ status: 'ok', skill_slug: 'pstack-interrogate', asset_count: 1 }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const service = createSkillService(env, fetcher);
  const result = await service.importGithub({
    repository: 'backnotprop/pstack',
    revision: sha,
    name: 'P-Stack Interrogate',
    slug: 'pstack-interrogate',
    license: 'MIT',
  });

  assert.match(JSON.stringify(result), /"status":"ok"/);
  assert.match(JSON.stringify(result), /pstack-interrogate/);
  assert.ok(calls[0]?.url.includes(sha));
  assert.ok(calls[0]?.url.endsWith('/SKILL.md'));
});
