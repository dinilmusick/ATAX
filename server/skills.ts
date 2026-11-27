import { createHash, timingSafeEqual } from 'node:crypto';

type SkillAssetInput = {
  path: string;
  asset_type?: string;
  content?: string;
  source_uri?: string;
  source_sha256?: string;
  executable?: boolean;
  mode?: string;
  metadata?: Record<string, unknown>;
};

type SkillPayload = {
  name: string;
  slug: string;
  description?: string;
  version?: string;
  instructions: string;
  source?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  assets?: SkillAssetInput[];
  changelog?: string;
  metadata?: Record<string, unknown>;
};

type Fetcher = typeof fetch;

function assertSlug(slug: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) {
    throw new Error('Invalid skill slug.');
  }
}

function assertRepository(repository: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Invalid GitHub repository.');
  }
}

function assertRevision(revision: string) {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('GitHub imports require an immutable 40-character commit SHA.');
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function operatorAuthorized(req: Request, env: Record<string, string | undefined>): boolean {
  const configured = env.ATAX_MCP_SHARED_TOKEN;
  if (!configured) return false;
  const header = req.headers.get('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!supplied) return false;
  const a = Buffer.from(sha256(supplied), 'hex');
  const b = Buffer.from(sha256(configured), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeAsset(asset: SkillAssetInput): SkillAssetInput {
  if (!asset.path || asset.path.length > 1000 || asset.path.startsWith('/') || asset.path.includes('..')) {
    throw new Error('Invalid skill asset path.');
  }
  const content = asset.content ?? '';
  if (content.length > 5_000_000) throw new Error('Skill asset exceeds 5 MB.');
  return {
    ...asset,
    content,
    source_sha256: asset.source_sha256 || sha256(content),
  };
}

function makeApi(env: Record<string, string | undefined>, fetcher: Fetcher) {
  const baseUrl = env.ATAX_SUPABASE_URL || env.SUPABASE_URL;
  const apiKey =
    env.ATAX_SUPABASE_SECRET_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SECRET_KEY;
  if (!baseUrl || !apiKey) throw new Error('Supabase backend is not connected.');

  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  return async (rpc: string, body: Record<string, unknown>) => {
    const response = await fetcher(`${baseUrl}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase RPC ${rpc} failed (HTTP ${response.status}).`);
    }
    return text ? JSON.parse(text) : null;
  };
}

async function githubFile(
  repository: string,
  revision: string,
  path: string,
  fetcher: Fetcher
): Promise<{ content: string; source_uri: string }> {
  const url = `https://raw.githubusercontent.com/${repository}/${revision}/${path}`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Unable to fetch GitHub skill asset: ${path}`);
  const content = await response.text();
  if (content.length > 5_000_000) throw new Error(`Skill asset exceeds 5 MB: ${path}`);
  return { content, source_uri: url };
}

export function createSkillService(
  env: Record<string, string | undefined> = process.env,
  fetcher: Fetcher = fetch
) {
  const callRpc = makeApi(env, fetcher);

  async function search(query: string) {
    return callRpc('atax_mcp_skills_search_v2', { query_in: query });
  }

  async function get(slug: string) {
    assertSlug(slug);
    return callRpc('atax_mcp_skill_get_v2', { slug_in: slug });
  }

  async function executable(slug: string) {
    assertSlug(slug);
    return callRpc('atax_mcp_skill_executable_spec_v2', { slug_in: slug });
  }

  async function register(payload: SkillPayload) {
    assertSlug(payload.slug);
    if (!payload.name || !payload.instructions) throw new Error('Skill name and instructions are required.');
    const assets = (payload.assets || []).map(normalizeAsset);
    return callRpc('atax_mcp_skill_register_v1', {
      payload: { ...payload, assets },
    });
  }

  async function importGithub(input: {
    repository: string;
    revision: string;
    name: string;
    slug: string;
    description?: string;
    version?: string;
    skill_path?: string;
    asset_paths?: Array<{ path: string; asset_type?: string; executable?: boolean; mode?: string }>;
    manifest?: Record<string, unknown>;
    license?: string;
  }) {
    assertRepository(input.repository);
    assertRevision(input.revision);
    assertSlug(input.slug);

    const skillPath = input.skill_path || 'SKILL.md';
    const skill = await githubFile(input.repository, input.revision, skillPath, fetcher);
    const assets: SkillAssetInput[] = [
      normalizeAsset({
        path: skillPath,
        asset_type: 'instruction',
        content: skill.content,
        source_uri: skill.source_uri,
      }),
    ];

    for (const spec of input.asset_paths || []) {
      const fetched = await githubFile(input.repository, input.revision, spec.path, fetcher);
      assets.push(normalizeAsset({
        path: spec.path,
        asset_type: spec.asset_type || 'code',
        executable: spec.executable || false,
        mode: spec.mode,
        content: fetched.content,
        source_uri: fetched.source_uri,
      }));
    }

    return register({
      name: input.name,
      slug: input.slug,
      description: input.description,
      version: input.version || '1.0.0',
      instructions: skill.content,
      source: {
        source_type: 'github',
        name: input.name,
        repository: input.repository,
        owner: input.repository.split('/')[0],
        uri: `https://github.com/${input.repository}/tree/${input.revision}/${skillPath}`,
        license: input.license || 'unknown',
        metadata: { immutable_revision: input.revision },
      },
      manifest: {
        ...(input.manifest || {}),
        source: { repository: input.repository, revision: input.revision, skill_path: skillPath },
      },
      assets,
      metadata: { imported_from_github: true, immutable_revision: input.revision },
    });
  }

  return { search, get, executable, register, importGithub, operatorAuthorized: (req: Request) => operatorAuthorized(req, env) };
}
