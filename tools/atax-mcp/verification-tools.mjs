/**
 * Verification tools for ATAX MCP:
 * - atax_npm_package_inspect: Query public npm registry metadata and dist.integrity/tarball for any package/version.
 * - atax_http_probe: Perform a bounded GET/HEAD probe against a public HTTPS endpoint (status, headers, latency, JSON/text preview).
 */

const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_PKG = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_VER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const tool = (name, description, scope, inputSchema, invoke) => ({name, description, scope, inputSchema, invoke});
const schema = (properties = {}, required = []) => ({type: 'object', properties, required, additionalProperties: false});

function assertPublicHttpsUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('Valid HTTPS URL is required');
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) {
    throw new Error('Only public HTTPS URLs without embedded credentials are permitted');
  }
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
    host === '[::1]'
  ) {
    throw new Error('Private or loopback hostnames are not permitted');
  }
  return u.toString();
}

async function npmPackageInspect(a, _db, _p, ctx) {
  const pkg = String(a.package_name || '').trim();
  if (!NPM_PKG.test(pkg) || pkg.length > 214) {
    throw new Error('Invalid npm package_name');
  }
  const registryBase = a.registry ? assertPublicHttpsUrl(a.registry).replace(/\/+$/, '') : NPM_REGISTRY;
  const requestedVersion = a.version ? String(a.version).trim() : '';
  if (requestedVersion && !NPM_VER.test(requestedVersion)) {
    throw new Error('Invalid npm package version or dist-tag');
  }

  const encodedPkg = pkg.startsWith('@')
    ? `@${encodeURIComponent(pkg.slice(1).split('/')[0])}/${encodeURIComponent(pkg.slice(1).split('/')[1])}`
    : encodeURIComponent(pkg);

  const fetchPackument = !requestedVersion || requestedVersion === 'latest';
  const url = fetchPackument
    ? `${registryBase}/${encodedPkg}`
    : `${registryBase}/${encodedPkg}/${encodeURIComponent(requestedVersion)}`;

  const res = await ctx.fetcher(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      accept: fetchPackument ? 'application/vnd.npm.install-v1+json, application/json;q=0.9' : 'application/json',
      'user-agent': 'atax-mcp-control-plane',
    },
  });
  if (!res.ok) {
    throw new Error(`npm registry lookup failed (HTTP ${res.status})`);
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error('npm registry returned invalid JSON');
  }

  if (fetchPackument) {
    const distTags = payload?.['dist-tags'] || {};
    const targetVersion = distTags.latest;
    const verData = targetVersion ? payload?.versions?.[targetVersion] : null;
    if (!verData) {
      return {
        operation: 'npm_package_inspect',
        package_name: payload?.name || pkg,
        registry: registryBase,
        dist_tags: distTags,
        version: targetVersion || null,
        dist: null,
      };
    }
    return {
      operation: 'npm_package_inspect',
      package_name: verData.name || payload?.name || pkg,
      registry: registryBase,
      version: verData.version || targetVersion,
      dist_tags: distTags,
      dist: verData.dist
        ? {
            integrity: verData.dist.integrity ?? null,
            shasum: verData.dist.shasum ?? null,
            tarball: verData.dist.tarball ?? null,
            fileCount: verData.dist.fileCount ?? null,
            unpackedSize: verData.dist.unpackedSize ?? null,
          }
        : null,
      dependencies: verData.dependencies ?? {},
      peerDependencies: verData.peerDependencies ?? {},
      deprecated: verData.deprecated ?? null,
      published_at: payload?.time?.[verData.version] ?? null,
    };
  }

  return {
    operation: 'npm_package_inspect',
    package_name: payload?.name || pkg,
    registry: registryBase,
    version: payload?.version || requestedVersion,
    dist: payload?.dist
      ? {
          integrity: payload.dist.integrity ?? null,
          shasum: payload.dist.shasum ?? null,
          tarball: payload.dist.tarball ?? null,
          fileCount: payload.dist.fileCount ?? null,
          unpackedSize: payload.dist.unpackedSize ?? null,
        }
      : null,
    dependencies: payload?.dependencies ?? {},
    peerDependencies: payload?.peerDependencies ?? {},
    deprecated: payload?.deprecated ?? null,
  };
}

const SAFE_RESP_HEADERS = ['content-type', 'cache-control', 'cf-ray', 'server', 'etag', 'last-modified', 'location'];

async function httpProbe(a, _db, _p, ctx) {
  const targetUrl = assertPublicHttpsUrl(a.url);
  const method = a.method === 'HEAD' ? 'HEAD' : 'GET';
  const maxBytes = a.max_bytes ?? 16384;
  const reqHeaders = {'user-agent': 'atax-mcp-control-plane', accept: 'application/json, text/plain;q=0.9, */*;q=0.5'};
  if (a.headers && typeof a.headers === 'object' && !Array.isArray(a.headers)) {
    for (const [k, v] of Object.entries(a.headers)) {
      const lower = String(k).toLowerCase().trim();
      if (!lower || lower === 'host' || lower === 'authorization' || lower === 'cookie' || typeof v !== 'string') continue;
      reqHeaders[lower] = v.slice(0, 512);
    }
  }

  const startedAt = Date.now();
  const res = await ctx.fetcher(targetUrl, {
    method,
    redirect: 'manual',
    headers: reqHeaders,
  });
  const latencyMs = Date.now() - startedAt;

  const headers = {};
  for (const name of SAFE_RESP_HEADERS) {
    const val = res.headers?.get?.(name);
    if (val) headers[name] = val;
  }
  const contentType = headers['content-type'] || '';
  let bodyPreview = null;
  let parsedJson = undefined;
  let bodyTruncated = false;

  if (method !== 'HEAD') {
    const raw = await res.text();
    if (raw.length > maxBytes) {
      bodyPreview = raw.slice(0, maxBytes);
      bodyTruncated = true;
    } else {
      bodyPreview = raw;
      if (contentType.toLowerCase().includes('json') || raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          // Leave as bodyPreview when invalid JSON
        }
      }
    }
  }

  return {
    operation: 'http_probe',
    url: targetUrl,
    method,
    status: res.status,
    ok: res.ok,
    latency_ms: latencyMs,
    redirect_location: headers.location ?? null,
    headers,
    content_type: contentType || null,
    body_truncated: bodyTruncated,
    ...(parsedJson !== undefined ? {json: parsedJson} : {body_preview: bodyPreview}),
  };
}

export const verificationTools = [
  tool(
    'atax_npm_package_inspect',
    'Inspect public npm registry metadata, dist.integrity (sha512), shasum, tarball URL, and dependencies for a package and optional version or dist-tag.',
    'atax:read',
    schema(
      {
        package_name: {type: 'string', minLength: 1, maxLength: 214, description: 'npm package name (e.g. @ultrst-armada/kloks)'},
        version: {type: 'string', minLength: 1, maxLength: 128, description: 'Optional exact version (e.g. 3.0.25) or dist-tag (e.g. latest)'},
        registry: {type: 'string', minLength: 10, maxLength: 256, description: 'Optional public HTTPS npm registry base URL (defaults to https://registry.npmjs.org)'},
      },
      ['package_name']
    ),
    npmPackageInspect
  ),
  tool(
    'atax_http_probe',
    'Perform a bounded GET or HEAD probe against a public HTTPS endpoint to verify live status, headers, latency, and JSON/text response.',
    'atax:read',
    schema(
      {
        url: {type: 'string', minLength: 10, maxLength: 2048, description: 'Public HTTPS URL to probe'},
        method: {type: 'string', enum: ['GET', 'HEAD'], description: 'HTTP method (default GET)'},
        headers: {type: 'object', description: 'Optional non-auth request headers'},
        max_bytes: {type: 'integer', minimum: 256, maximum: 32768, description: 'Maximum response body bytes to read (default 16384)'},
      },
      ['url']
    ),
    httpProbe
  ),
];
