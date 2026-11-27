import { describe, expect, it } from 'vitest';
import { createSkillService } from './skills.ts';

describe('skill service', () => {
  it('rejects mutable GitHub refs before fetching', async () => {
    const service = createSkillService(
      { ATAX_SUPABASE_URL: 'https://example.supabase.co', ATAX_SUPABASE_SECRET_KEY: 'test', ATAX_MCP_SHARED_TOKEN: 'token' },
      (async () => new Response('{}')) as typeof fetch
    );
    await expect(service.importGithub({
      repository: 'backnotprop/pstack',
      revision: 'main',
      name: 'P-Stack Interrogate',
      slug: 'pstack-interrogate',
    })).rejects.toThrow(/immutable 40-character commit SHA/);
  });

  it('imports an immutable GitHub skill and preserves source assets', async () => {
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

    const service = createSkillService(
      { ATAX_SUPABASE_URL: 'https://example.supabase.co', ATAX_SUPABASE_SECRET_KEY: 'test', ATAX_MCP_SHARED_TOKEN: 'token' },
      fetcher
    );
    const result = await service.importGithub({
      repository: 'backnotprop/pstack',
      revision: sha,
      name: 'P-Stack Interrogate',
      slug: 'pstack-interrogate',
      license: 'MIT',
    });

    expect(result).toMatchObject({ status: 'ok', skill_slug: 'pstack-interrogate' });
    expect(calls[0]?.url).toContain(sha);
    expect(calls[0]?.url).toContain('skills/SKILL.md');
  });
});
