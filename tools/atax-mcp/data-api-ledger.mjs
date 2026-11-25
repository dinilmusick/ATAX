/**
 * tools/atax-mcp/data-api-ledger.mjs
 * Pure HTTPS Supabase Data API / PostgREST transport for the canonical ATAX ledger.
 * Sole canonical transport for the ATAX ledger via native HTTPS fetch() to PostgREST.
 * Zero external npm runtime dependencies.
 * Fail-closed, sanitized error mapping; zero secret leakage.
 */

export const PARAM_KEY_REGEX = /^[a-z][a-z0-9_]{0,100}$/;
const SAFE_SECRET = /^[A-Za-z0-9._\-+/=]{20,8192}$/;
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PARAM_COUNT = 40;
const MAX_PAYLOAD_BYTES = 1048576; // 1 MB
const MAX_RECURSION_DEPTH = 16;

/**
 * Canonical allowlist of the 35 ATAX PostgreSQL RPC functions in the public schema.
 * Rejects arbitrary function dispatch prior to network transmission.
 */
export const CANONICAL_RPC_ALLOWLIST = Object.freeze(new Set([
  // Context & Snapshot (3)
  'agent_context_overview',
  'atax_context_snapshot',
  'system_improvement_context',

  // Goals & Dependencies (8)
  'goal_ledger_overview',
  'goal_ledger_get_by_key',
  'goal_ledger_resume_by_key',
  'goal_ledger_blocker_overview',
  'goal_ledger_set_priority',
  'goal_ledger_add_dependency',
  'goal_ledger_finalize_by_key',
  'atax_goal_create_system_bounded',

  // Omni Goals & Vision Substrate (4)
  'vision_ledger_create',
  'vision_ledger_add_target',
  'vision_ledger_attach_tldraw',
  'atax_goal_create_system_omni',

  // Tasks, Claims, Leases & Loops (10)
  'task_ledger_claim_next',
  'atax_goal_claim_safe',
  'task_ledger_check_claim',
  'task_ledger_record_handoff',
  'task_ledger_heartbeat_claim',
  'task_ledger_record_loop_iteration',
  'task_ledger_submit_result',
  'task_ledger_release_claim',
  'task_ledger_add_dependency',
  'task_ledger_finalize_loop_script',

  // Independent Verification (4)
  'task_ledger_pending_verification',
  'task_ledger_claim_verification',
  'task_ledger_claim_verification_for_task',
  'task_ledger_verify_result_claimed',

  // Restricted Socket Gateway Transaction (1)
  'atax_socket_execute_v1',

  // Skills Registry & Runtime Configuration (5)
  'atax_mcp_skills_search_v1',
  'atax_mcp_skill_get_v1',
  'atax_mcp_skills_catalog_v1',
  'atax_mcp_runtime_config_v1',
  'atax_mcp_socket_config_v1',
]));

export const ALLOWED_RPCS = CANONICAL_RPC_ALLOWLIST;

/**
 * Additional canonical RPCs restricted to the server-side instance Settings/Vault control plane.
 * Never exposed to MCP tool callers through openLedger().
 */
export const INSTANCE_CONTROL_PLANE_RPCS = Object.freeze(new Set([
  'atax_mcp_instance_auth_status_v1',
  'atax_mcp_verify_instance_passkey_v1',
  'atax_mcp_create_instance_session_v1',
  'atax_mcp_validate_instance_session_v1',
  'atax_mcp_revoke_instance_session_v1',
  'atax_mcp_instance_owner_subject_v1',
  'atax_mcp_provider_summary_v1',
  'atax_mcp_upsert_provider_v1',
  'atax_mcp_set_provider_enabled_v1',
  'atax_mcp_delete_provider_v1',
  'atax_mcp_audit_provider_test_v1',
  'atax_mcp_set_settings_v1',
]));

export const CONTROL_PLANE_RPC_ALLOWLIST = Object.freeze(new Set([
  ...CANONICAL_RPC_ALLOWLIST,
  ...INSTANCE_CONTROL_PLANE_RPCS,
]));

export class LedgerError extends Error {
  constructor(message, code = 'LEDGER_ERROR', status = 500, rpcName = null) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.status = status;
    this.rpcName = rpcName;
  }
}

/**
 * Asserts that an RPC function name is included in the allowlist.
 * @param {string} name
 * @param {Set<string>} [allowlist=CANONICAL_RPC_ALLOWLIST]
 */
export function assertAllowedRpc(name, allowlist = CANONICAL_RPC_ALLOWLIST) {
  if (typeof name !== 'string' || !allowlist.has(name)) {
    throw new LedgerError(
      `Invalid canonical RPC: ${typeof name === 'string' ? name.slice(0, 64) : 'unknown'}`,
      'RPC_NOT_ALLOWED',
      400
    );
  }
}

/**
 * Validates and extracts canonical Supabase Data API configuration from environment.
 * Validates ATAX_SUPABASE_URL / SUPABASE_URL and ATAX_SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY.
 * Guarantees zero secret leakage in all error conditions.
 * @param {Record<string, any>} env
 * @returns {{ url: string, baseUrl: string, key: string, apiKey: string }}
 */
export function parseDataApiConfig(env) {
  if (!env || typeof env !== 'object') {
    throw new LedgerError('Canonical Supabase configuration unavailable', 'CONFIG_ERROR', 503);
  }

  const urlRaw = env.ATAX_SUPABASE_URL || env.SUPABASE_URL;
  const keyRaw = env.ATAX_SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;

  if (typeof urlRaw !== 'string' || !urlRaw.trim()) {
    throw new LedgerError('Canonical Supabase Data API URL unavailable', 'CONFIG_ERROR', 503);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlRaw.trim());
  } catch {
    throw new LedgerError('Invalid Supabase Data API URL', 'CONFIG_ERROR', 503);
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new LedgerError('ATAX requires a canonical HTTPS Supabase URL', 'CONFIG_ERROR', 503);
  }

  const hostname = parsedUrl.hostname;
  if (
    !hostname ||
    !(hostname.endsWith('.supabase.co') || hostname.endsWith('.supabase.com')) ||
    hostname.includes('..') ||
    hostname.startsWith('.')
  ) {
    throw new LedgerError('ATAX requires a canonical Supabase hostname (.supabase.co or .supabase.com)', 'CONFIG_ERROR', 503);
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new LedgerError('Supabase URL must not contain user credentials', 'CONFIG_ERROR', 503);
  }

  if (parsedUrl.search || parsedUrl.hash) {
    throw new LedgerError('Supabase URL must not contain query parameters or hash', 'CONFIG_ERROR', 503);
  }

  if (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/') {
    throw new LedgerError('Invalid Supabase Data API URL pathname', 'CONFIG_ERROR', 503);
  }

  if (typeof keyRaw !== 'string' || keyRaw.length < 20 || keyRaw.length > 8192) {
    throw new LedgerError('Canonical Supabase Data API key unavailable', 'CONFIG_ERROR', 503);
  }

  if (!SAFE_SECRET.test(keyRaw)) {
    throw new LedgerError('Invalid Supabase Data API key format', 'CONFIG_ERROR', 503);
  }

  return {
    url: parsedUrl.origin,
    baseUrl: parsedUrl.origin,
    key: keyRaw,
    apiKey: keyRaw,
  };
}

export const parseSupabaseConfig = parseDataApiConfig;

/**
 * Recursively asserts that a parameter value is JSON serializable, finite,
 * and contains no circular references, non-plain objects, or forbidden keys.
 */
function validateValue(value, path, seen, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new LedgerError(`Parameter recursion depth limit exceeded at ${path}`, 'INVALID_ARGUMENTS', 400);
  }
  if (value === undefined) {
    throw new LedgerError(`Undefined parameter value not permitted at ${path}`, 'INVALID_ARGUMENTS', 400);
  }
  if (value === null) return;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new LedgerError(`Invalid non-finite number at ${path}`, 'INVALID_ARGUMENTS', 400);
    }
    return;
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    throw new LedgerError(`Non-serializable parameter type '${type}' at ${path}`, 'INVALID_ARGUMENTS', 400);
  }

  if (type === 'object') {
    if (seen.has(value)) {
      throw new LedgerError(`Cyclic reference detected at ${path}`, 'INVALID_ARGUMENTS', 400);
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        validateValue(value[i], `${path}[${i}]`, seen, depth + 1);
      }
      seen.delete(value);
      return;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new LedgerError(`Non-plain object rejected at ${path}`, 'INVALID_ARGUMENTS', 400);
    }

    for (const [key, val] of Object.entries(value)) {
      if (BANNED_KEYS.has(key)) {
        throw new LedgerError(`Prototype pollution key rejected: ${key}`, 'INVALID_ARGUMENTS', 400);
      }
      validateValue(val, `${path}.${key}`, seen, depth + 1);
    }
    seen.delete(value);
  }
}

/**
 * Validates the complete parameters payload for an RPC invocation.
 * @param {Record<string, any>} params
 * @returns {string} Serialized JSON payload
 */
export function validateRpcParams(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new LedgerError('RPC parameters must be a plain object', 'INVALID_ARGUMENTS', 400);
  }
  const proto = Object.getPrototypeOf(params);
  if (proto !== Object.prototype && proto !== null) {
    throw new LedgerError('RPC parameters must be a plain object', 'INVALID_ARGUMENTS', 400);
  }

  const entries = Object.entries(params);
  if (entries.length > MAX_PARAM_COUNT) {
    throw new LedgerError(`Parameter count (${entries.length}) exceeds maximum limit (${MAX_PARAM_COUNT})`, 'INVALID_ARGUMENTS', 400);
  }

  const seen = new Set();
  for (const [key, val] of entries) {
    if (BANNED_KEYS.has(key) || !PARAM_KEY_REGEX.test(key)) {
      throw new LedgerError(`Invalid canonical parameter key: ${key}`, 'INVALID_ARGUMENTS', 400);
    }
    validateValue(val, key, seen, 0);
  }

  let serialized;
  try {
    serialized = JSON.stringify(params);
  } catch {
    throw new LedgerError('Parameters failed JSON serialization', 'INVALID_ARGUMENTS', 400);
  }

  if (new TextEncoder().encode(serialized).length > MAX_PAYLOAD_BYTES) {
    throw new LedgerError('Parameter payload size exceeds 1MB limit', 'INVALID_ARGUMENTS', 400);
  }

  return serialized;
}

/**
 * Sanitizes raw error messages by scrubbing sensitive tokens, URLs, hashes, and control characters.
 * @param {string} rawMessage
 * @returns {string} Sanitized safe string
 */
export function sanitizeErrorMessage(rawMessage) {
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
    return 'Canonical operation denied or unavailable';
  }
  return rawMessage
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_URI]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]')
    .replace(/atax_[a-f0-9]{48}/gi, '[REDACTED_TOKEN]')
    .replace(/[a-f0-9]{64}/gi, '[REDACTED_HASH]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Maps PostgREST HTTP responses and PostgreSQL errors to sanitized LedgerError instances.
 * @param {Response} response
 * @param {string|null} rpcName
 * @param {string|null} apiKey
 * @param {string|null} baseUrl
 * @returns {Promise<LedgerError>}
 */
export async function mapPostgrestError(response, rpcName = null, apiKey = null, baseUrl = null) {
  const status = response.status;
  let rawBody = null;
  try {
    rawBody = await response.json();
  } catch {
    try {
      rawBody = { message: await response.text() };
    } catch {
      rawBody = { message: 'Upstream returned unparseable error' };
    }
  }

  const rawMessage = typeof rawBody?.message === 'string' ? rawBody.message : '';
  const pgCode = typeof rawBody?.code === 'string' ? rawBody.code : '';
  let sanitized = sanitizeErrorMessage(rawMessage);
  if (apiKey) sanitized = sanitized.split(apiKey).join('[REDACTED]');
  if (baseUrl) sanitized = sanitized.split(baseUrl).join('[REDACTED]');

  // 1. plpgsql RAISE EXCEPTION (SQLSTATE P0001)
  if (status === 400 && pgCode === 'P0001') {
    if (/claim.*not found|expired|not owned/i.test(sanitized)) {
      return new LedgerError('Task claim not found, expired, or not owned by agent', 'LEASE_EXPIRED_OR_INVALID', 400, rpcName);
    }
    if (/task socket is still owned/i.test(sanitized)) {
      return new LedgerError('Task socket is still owned; checkpoint or release it normally', 'CLAIM_ACTIVE_NOT_FORFEITED', 400, rpcName);
    }
    if (/unrecognized.*claim/i.test(sanitized)) {
      return new LedgerError('Unrecognized or still-owned former socket claim', 'UNRECOGNIZED_PRIOR_CLAIM', 400, rpcName);
    }
    if (/passing task loop iteration/i.test(sanitized)) {
      return new LedgerError('Completed submission requires a passing task loop iteration with evidence', 'LOOP_ITERATION_REQUIRED', 400, rpcName);
    }
    if (/cannot verify.*own/i.test(sanitized)) {
      return new LedgerError('Worker cannot verify its own submitted result', 'SELF_VERIFICATION_PROHIBITED', 400, rpcName);
    }
    if (/not awaiting verification/i.test(sanitized)) {
      return new LedgerError('Task is not awaiting verification', 'TASK_NOT_AWAITING_VERIFICATION', 400, rpcName);
    }
    if (/active System not found/i.test(sanitized)) {
      return new LedgerError('Active system not found', 'SYSTEM_NOT_FOUND', 404, rpcName);
    }
    if (/goal not found/i.test(sanitized)) {
      return new LedgerError('Goal not found', 'GOAL_NOT_FOUND', 404, rpcName);
    }
    if (/priority must be between/i.test(sanitized)) {
      return new LedgerError('Priority must be between 0 and 1', 'INVALID_PRIORITY', 400, rpcName);
    }
    if (/agent identity is required/i.test(sanitized)) {
      return new LedgerError('Agent identity is required', 'AGENT_IDENTITY_REQUIRED', 400, rpcName);
    }

    if (/^[a-zA-Z0-9_\- ,.:;!'"]{1,200}$/.test(sanitized)) {
      return new LedgerError(sanitized, 'LEDGER_RULE_VIOLATION', 400, rpcName);
    }
    return new LedgerError('Canonical operation rejected by ledger constraint', 'LEDGER_RULE_VIOLATION', 400, rpcName);
  }

  // 2. PostgreSQL Relational Integrity Constraints
  if (pgCode === '23505') {
    return new LedgerError('Canonical ledger constraint violation: duplicate record', 'UNIQUE_VIOLATION', 409, rpcName);
  }
  if (pgCode === '23503') {
    return new LedgerError('Canonical ledger constraint violation: referenced entity not found', 'FOREIGN_KEY_VIOLATION', 400, rpcName);
  }
  if (pgCode === '23514') {
    return new LedgerError('Canonical ledger constraint violation: check constraint failed', 'CHECK_VIOLATION', 400, rpcName);
  }

  // 3. PostgREST Schema Cache / Function Overload Not Found
  if (status === 404 || pgCode === 'PGRST202' || pgCode === '42883') {
    return new LedgerError('Canonical ledger function not found or parameter mismatch', 'RPC_NOT_FOUND', 404, rpcName);
  }

  // 4. Authentication / Authorization Failures
  if (status === 401 || status === 403) {
    return new LedgerError('Canonical ledger authorization failed', 'UNAUTHORIZED', status, rpcName);
  }

  // 5. Upstream Service Failures (5xx)
  if (status >= 500) {
    return new LedgerError(`Canonical ledger service temporarily unavailable (HTTP ${status})`, 'UPSTREAM_UNAVAILABLE', status, rpcName);
  }

  // 6. Plpgsql exception or 400 without P0001 code
  if (status === 400 && sanitized && /^[a-zA-Z0-9_\- ,.:;!'"]{1,200}$/.test(sanitized)) {
    return new LedgerError(sanitized, 'LEDGER_RULE_VIOLATION', 400, rpcName);
  }

  return new LedgerError('Canonical operation denied or unavailable', 'LEDGER_ERROR', status, rpcName);
}

/**
 * Creates the pure HTTPS PostgREST Data API ledger client.
 * @param {{ baseUrl: string, apiKey: string, url?: string, key?: string }} config
 * @param {typeof fetch} [fetcher=fetch]
 */
export function createLedgerDb(config, fetcher = fetch, allowlist = CANONICAL_RPC_ALLOWLIST) {
  const baseUrl = config.baseUrl || config.url;
  const apiKey = config.apiKey || config.key;

  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string') {
    throw new LedgerError('Invalid ledger configuration', 'CONFIG_ERROR', 503);
  }

  /**
   * Dispatches an RPC function call to Supabase PostgREST.
   * @param {string} name Function name in public schema
   * @param {Record<string, any>} [params={}] Function arguments
   * @returns {Promise<any>} Parsed result
   */
  async function rpc(name, params = {}) {
    assertAllowedRpc(name, allowlist);
    const bodyString = validateRpcParams(params);

    const endpoint = `${baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`;
    const headers = {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    let response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new LedgerError('Canonical ledger request timed out', 'TIMEOUT', 504, name);
      }
      throw new LedgerError('Canonical ledger network transport error', 'NETWORK_ERROR', 503, name);
    }

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw await mapPostgrestError(response, name, apiKey, baseUrl);
    }

    const text = await response.text();
    if (!text || text.trim() === '') {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new LedgerError('Invalid JSON response from canonical ledger', 'INVALID_RESPONSE', 502, name);
    }
  }

  /**
   * Search skills by term.
   * @param {string} term
   */
  async function skills(term) {
    return rpc('atax_mcp_skills_search_v1', { term_in: String(term ?? '').slice(0, 120) });
  }

  /**
   * Fetch full instructions for a published skill by slug.
   * @param {string} slug
   */
  async function skill(slug) {
    return rpc('atax_mcp_skill_get_v1', { slug_in: String(slug ?? '').slice(0, 120) });
  }

  /**
   * Direct authenticated REST request to Supabase /rest/v1 endpoint.
   * Used for resource listings (e.g., skills catalog).
   * @param {string} path Subpath under /rest/v1/
   * @param {RequestInit} [options={}]
   */
  async function request(path, options = {}) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 2048) {
      throw new LedgerError('Invalid canonical request path', 'INVALID_ARGUMENTS', 400);
    }
    const cleanPath = path.replace(/^\/+/, '');
    if (cleanPath.includes('..') || cleanPath.includes('\0')) {
      throw new LedgerError('Invalid canonical request path', 'INVALID_ARGUMENTS', 400);
    }

    const endpoint = `${baseUrl}/rest/v1/${cleanPath}`;
    const customHeaders = options?.headers
      ? Object.fromEntries(new Headers(options.headers).entries())
      : {};

    const headers = {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...customHeaders,
    };

    let res;
    try {
      res = await fetcher(endpoint, {
        ...options,
        headers,
        signal: options?.signal || AbortSignal.timeout(15000),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new LedgerError('Canonical ledger request timed out', 'TIMEOUT', 504);
      }
      throw new LedgerError('Canonical transport request failed', 'NETWORK_ERROR', 503);
    }

    if (res.status === 204) {
      return null;
    }

    if (!res.ok) {
      throw await mapPostgrestError(res, cleanPath, apiKey, baseUrl);
    }

    const text = await res.text();
    if (!text || text.trim() === '') {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new LedgerError('Canonical response parsing failed', 'INVALID_RESPONSE', 502);
    }
  }

  async function ping() {
    await rpc('atax_mcp_runtime_config_v1', {});
    return true;
  }

  return { rpc, skills, skill, request, ping };
}

/**
 * Asynchronously opens the canonical ledger database via Supabase Data API.
 * @param {Record<string, any>} bootstrapEnv
 * @param {typeof fetch} [fetcher=fetch]
 */
export async function openLedger(bootstrapEnv, fetcher = fetch) {
  const config = parseDataApiConfig(bootstrapEnv);
  return createLedgerDb(config, fetcher, CANONICAL_RPC_ALLOWLIST);
}

/**
 * Opens the server-only Data API client permitted to execute singleton instance-auth
 * and Vault control-plane RPCs in addition to the canonical ledger RPCs.
 * @param {Record<string, any>} bootstrapEnv
 * @param {typeof fetch} [fetcher=fetch]
 */
export async function openControlPlaneLedger(bootstrapEnv, fetcher = fetch) {
  const config = parseDataApiConfig(bootstrapEnv);
  return createLedgerDb(config, fetcher, CONTROL_PLANE_RPC_ALLOWLIST);
}
