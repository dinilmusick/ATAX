import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  Database,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  Lock,
  Power,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
  Triangle,
  Unlock,
} from 'lucide-react';
import type {
  ProviderAccountSummary,
  ProviderTestResult,
  ProviderType,
  SettingsStatusResponse,
} from '../types/substrate';

interface OperatorSession {
  token: string;
  subject: string;
  expiresAt: number;
}

interface SettingsViewProps {
  session: OperatorSession | null;
  onSessionChange: (session: OperatorSession | null) => void;
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

const PROVIDERS: Array<{
  id: ProviderType;
  label: string;
  accountIdLabel: string;
  accountIdPlaceholder: string;
  tokenPlaceholder: string;
  hint: string;
}> = [
  {
    id: 'github',
    label: 'GitHub',
    accountIdLabel: 'GitHub Owner / Org (optional)',
    accountIdPlaceholder: 'owner-or-org',
    tokenPlaceholder: 'github_pat_... or ghp_...',
    hint: 'Stored in Supabase Vault for repository creation, FMRL workflows, and private CI dispatch.',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    accountIdLabel: 'Cloudflare Account ID (optional)',
    accountIdPlaceholder: '32-char account identifier',
    tokenPlaceholder: 'Cloudflare API token...',
    hint: 'Stored in Supabase Vault for Workers /mcp deployment and edge diagnostics.',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    accountIdLabel: 'Vercel Team / Org ID (optional)',
    accountIdPlaceholder: 'team_...',
    tokenPlaceholder: 'Vercel access token...',
    hint: 'Stored in Supabase Vault for project inspection and deployment credential binding.',
  },
];

function ProviderIcon({ provider, className = 'w-4 h-4' }: { provider: ProviderType; className?: string }) {
  if (provider === 'github') return <GitBranch className={className} />;
  if (provider === 'cloudflare') return <Cloud className={className} />;
  return <Triangle className={className} />;
}

export function SettingsView({
  session,
  onSessionChange,
  refreshTick = 0,
  onLoadingChange,
}: SettingsViewProps) {
  const [status, setStatus] = useState<SettingsStatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Auth form state (in-memory only)
  const [operatorSubjectInput, setOperatorSubjectInput] = useState('');
  const [passphraseInput, setPassphraseInput] = useState('');
  const [confirmPassphraseInput, setConfirmPassphraseInput] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Provider secrets state
  const [activeProvider, setActiveProvider] = useState<ProviderType>('github');
  const [accounts, setAccounts] = useState<ProviderAccountSummary[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [aliasInput, setAliasInput] = useState('');
  const [accountIdInput, setAccountIdInput] = useState('');
  const [credentialInput, setCredentialInput] = useState('');
  const [showCredential, setShowCredential] = useState(false);
  const [saveSubmitting, setSaveSubmitting] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  // Per-row action state
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
  const tokenInputRef = useRef<HTMLInputElement | null>(null);

  const loadStatus = useCallback(async (tokenOverride?: string | null) => {
    setLoadingStatus(true);
    onLoadingChange?.(true);
    setStatusError(null);
    try {
      const token = tokenOverride !== undefined ? tokenOverride : session?.token;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/settings/status', { headers });
      if (!res.ok) {
        throw new Error(`Status check failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as SettingsStatusResponse;
      setStatus(data);
      if (token && !data.authenticated) {
        onSessionChange(null);
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Unable to reach backend settings API.');
    } finally {
      setLoadingStatus(false);
      onLoadingChange?.(false);
    }
  }, [session?.token, onSessionChange, onLoadingChange]);

  const loadAccounts = useCallback(async (token: string) => {
    setLoadingAccounts(true);
    try {
      const res = await fetch('/api/settings/providers', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        onSessionChange(null);
        return;
      }
      const data = (await res.json()) as { accounts?: ProviderAccountSummary[]; error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Failed to load Vault accounts (HTTP ${res.status})`);
      }
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (err) {
      setSaveFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load provider accounts.',
      });
    } finally {
      setLoadingAccounts(false);
    }
  }, [onSessionChange]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, refreshTick]);

  useEffect(() => {
    if (session?.token) {
      void loadAccounts(session.token);
    } else {
      setAccounts([]);
    }
  }, [session?.token, loadAccounts, refreshTick]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    const isSetup = !status?.operatorClaimed;
    if (isSetup) {
      if (passphraseInput.length < 10) {
        setAuthError('Passphrase must be at least 10 characters.');
        return;
      }
      if (passphraseInput !== confirmPassphraseInput) {
        setAuthError('Passphrases do not match.');
        return;
      }
    } else if (!passphraseInput) {
      setAuthError('Enter your operator passphrase.');
      return;
    }

    setAuthSubmitting(true);
    try {
      const endpoint = isSetup ? '/api/settings/auth/setup' : '/api/settings/auth/login';
      const payload = isSetup
        ? { subject: operatorSubjectInput.trim(), passphrase: passphraseInput }
        : { passphrase: passphraseInput };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as {
        token?: string;
        expiresAt?: number;
        subject?: string;
        error?: string;
      };
      if (!res.ok || !data.token || !data.subject || !data.expiresAt) {
        throw new Error(data.error || 'Authentication failed.');
      }

      setPassphraseInput('');
      setConfirmPassphraseInput('');
      onSessionChange({
        token: data.token,
        subject: data.subject,
        expiresAt: data.expiresAt,
      });
      await loadStatus(data.token);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to authenticate operator.');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLockSession = async () => {
    if (session?.token) {
      await fetch('/api/settings/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
      }).catch(() => undefined);
    }
    onSessionChange(null);
    setCredentialInput('');
    setSaveFeedback(null);
    await loadStatus(null);
  };

  const handleSaveSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.token) return;
    setSaveFeedback(null);

    const normalizedAlias = aliasInput.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,47}$/.test(normalizedAlias)) {
      setSaveFeedback({
        kind: 'error',
        message: 'Alias must start with A-Z and use only uppercase letters, numbers, or underscores.',
      });
      return;
    }
    if (credentialInput.trim().length < 16) {
      setSaveFeedback({
        kind: 'error',
        message: 'Secret token must be at least 16 characters.',
      });
      return;
    }

    setSaveSubmitting(true);
    try {
      const res = await fetch('/api/settings/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({
          provider: activeProvider,
          alias: normalizedAlias,
          accountId: accountIdInput.trim() || null,
          credential: credentialInput.trim(),
          enabled: true,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (res.status === 401) {
        onSessionChange(null);
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || `Save failed (HTTP ${res.status})`);
      }

      setCredentialInput('');
      setShowCredential(false);
      setSaveFeedback({
        kind: 'success',
        message: `Saved ${activeProvider} (${normalizedAlias}) securely to Supabase Vault.`,
      });
      await loadAccounts(session.token);
    } catch (err) {
      setSaveFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Unable to save secret.',
      });
    } finally {
      setSaveSubmitting(false);
    }
  };

  const handleToggleEnabled = async (account: ProviderAccountSummary) => {
    if (!session?.token) return;
    const key = `${account.provider}:${account.alias}`;
    setBusyKey(key);
    setSaveFeedback(null);
    try {
      const res = await fetch(
        `/api/settings/providers/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.alias)}/enabled`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.token}`,
          },
          body: JSON.stringify({ enabled: !account.enabled }),
        }
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to update account status.');
      await loadAccounts(session.token);
    } catch (err) {
      setSaveFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Unable to toggle account.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteAccount = async (account: ProviderAccountSummary) => {
    if (!session?.token) return;
    const key = `${account.provider}:${account.alias}`;
    setBusyKey(key);
    setSaveFeedback(null);
    try {
      const res = await fetch(
        `/api/settings/providers/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.alias)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session.token}` },
        }
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to remove secret.');
      setConfirmDeleteKey(null);
      setSaveFeedback({
        kind: 'success',
        message: `Removed ${account.provider} (${account.alias}) from Supabase Vault.`,
      });
      await loadAccounts(session.token);
    } catch (err) {
      setSaveFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Unable to delete account.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleTestAccount = async (account: ProviderAccountSummary) => {
    if (!session?.token) return;
    const key = `${account.provider}:${account.alias}`;
    setBusyKey(key);
    try {
      const res = await fetch(
        `/api/settings/providers/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.alias)}/test`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}` },
        }
      );
      const data = (await res.json()) as ProviderTestResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Connection probe failed.');
      }
      setTestResults((prev) => ({ ...prev, [key]: data }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [key]: {
          ok: false,
          provider: account.provider,
          alias: account.alias,
          statusCode: 500,
          summary: err instanceof Error ? err.message : 'Probe error.',
          checkedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setBusyKey(null);
    }
  };

  const activeProviderMeta = PROVIDERS.find((p) => p.id === activeProvider) || PROVIDERS[0];
  const providerAccounts = accounts.filter((a) => a.provider === activeProvider);
  const requiredEnvVars =
    status?.requiredEnvVars?.length ? status.requiredEnvVars : ['ATAX_SUPABASE_URL', 'ATAX_SUPABASE_SECRET_KEY'];

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 border-b border-[#382821] pb-3.5">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight text-[#F7F3EC]">
            Vault &amp; Environment Settings
          </h1>
          <p className="text-xs text-[#B9AA9D] mt-0.5 max-w-2xl">
            Data API bootstrap configuration. Provider secrets for GitHub, Cloudflare, and Vercel
            are encrypted in Supabase Vault and never exposed to the browser bundle.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {session && (
            <button
              type="button"
              onClick={handleLockSession}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-[#4A362D] bg-[#211613] text-[#F2EBE1] hover:border-[#C83214] rounded-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5 text-[#E04819]" />
              Lock Vault
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadStatus()}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-[#3F2E27] bg-[#1A110E] text-[#D8CFC2] hover:text-[#F7F3EC] hover:border-[#6A4E42] rounded-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus ? 'animate-spin' : ''}`} />
            Refresh Status
          </button>
        </div>
      </div>

      {statusError && (
        <div
          role="alert"
          className="border border-[#C83214] bg-[#2B1410] px-4 py-2.5 text-xs text-[#F7F3EC] rounded-sm"
        >
          {statusError}
        </div>
      )}

      {/* Runtime Environment Contract Panel */}
      <section
        aria-labelledby="env-contract-heading"
        className="border border-[#3F2E27] bg-[#1A110E] px-4 py-3.5 rounded-sm"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[11px] font-mono text-[#A89688]">
              <Database className="w-3.5 h-3.5 text-[#DF6B3B]" />
              <span>RUNTIME ENVIRONMENT CONTRACT</span>
              <span aria-hidden="true">·</span>
              <span>
                {requiredEnvVars.length}{' '}
                {requiredEnvVars.length === 1 ? 'VARIABLE REQUIRED' : 'VARIABLES REQUIRED'}
              </span>
            </div>
            <h2
              id="env-contract-heading"
              className="font-display text-base font-semibold text-[#F7F3EC] flex flex-wrap items-center gap-2"
            >
              {requiredEnvVars.map((envVar, idx) => (
                <React.Fragment key={envVar}>
                  {idx > 0 && <span className="text-[#9C8A7C] font-mono text-sm">+</span>}
                  <span className="font-mono">{envVar}</span>
                </React.Fragment>
              ))}
            </h2>
            <p className="text-xs text-[#B9AA9D] max-w-2xl">
              These HTTPS Supabase Data API credentials are all that is needed to boot ATAX. All
              GitHub, Cloudflare, and Vercel secrets live encrypted inside Supabase Vault.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-4 border-t lg:border-t-0 pt-3 lg:pt-0 border-[#352620] font-mono text-xs shrink-0">
            <div>
              <div className="text-[11px] text-[#9C8A7C]">Supabase Backend</div>
              <div className="mt-0.5 flex items-center gap-2">
                {loadingStatus ? (
                  <span className="text-[#B9AA9D]">Checking...</span>
                ) : status?.supabaseConfigured ? (
                  <span className="text-[#6CC48E] font-medium">
                    Connected · {status.supabaseHost}
                  </span>
                ) : (
                  <span className="text-[#E09F3E] font-medium">
                    Not configured in environment
                  </span>
                )}
              </div>
            </div>

            <div className="hidden sm:block w-px h-8 bg-[#382821]" aria-hidden="true" />

            <div>
              <div className="text-[11px] text-[#9C8A7C]">Operator Session</div>
              <div className="mt-0.5">
                {session ? (
                  <span className="text-[#6CC48E] font-medium">
                    Unlocked · {session.subject}
                  </span>
                ) : status?.operatorClaimed ? (
                  <span className="text-[#DFE4D8]">Locked · Passphrase required</span>
                ) : (
                  <span className="text-[#DF6B3B]">Initial setup required</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {status?.supabaseError && (
          <div className="mt-4 border-t border-[#382821] pt-3 text-xs font-mono text-[#E04819]">
            Connection notice: {status.supabaseError}
          </div>
        )}
      </section>

      {/* Operator Auth Gate OR Provider Vault Workspace */}
      {!session ? (
        <section
          aria-labelledby="operator-auth-heading"
          className="border border-[#433129] bg-[#211613] p-6 rounded-sm max-w-xl"
        >
          <div className="flex items-center gap-2.5 mb-2">
            <ShieldCheck className="w-5 h-5 text-[#E04819]" />
            <h2 id="operator-auth-heading" className="font-display text-lg font-semibold text-[#F7F3EC]">
              {status?.operatorClaimed ? 'Unlock Provider Secret Vault' : 'Claim Operator Vault Access'}
            </h2>
          </div>
          <p className="text-xs text-[#C8B9AC] leading-relaxed mb-5">
            {status?.operatorClaimed
              ? 'Enter your operator passphrase to manage GitHub, Cloudflare, and Vercel secrets in Supabase Vault. Your session token stays strictly in memory.'
              : 'No separate admin password environment variable is needed. Set an operator passphrase to protect secret mutations during this server session.'}
          </p>

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            {!status?.operatorClaimed && (
              <div>
                <label
                  htmlFor="operator-subject"
                  className="block text-xs font-mono text-[#D8CFC2] mb-1.5"
                >
                  Operator Subject
                </label>
                <input
                  id="operator-subject"
                  type="text"
                  value={operatorSubjectInput}
                  onChange={(e) => setOperatorSubjectInput(e.target.value)}
                  placeholder="operator-name"
                  required
                  minLength={3}
                  maxLength={120}
                  className="w-full bg-[#140D0B] border border-[#4A362D] px-3 py-2 text-sm font-mono text-[#F2EBE1] rounded-sm focus:outline-none focus:border-[#C83214]"
                />
              </div>
            )}

            <div>
              <label
                htmlFor="operator-passphrase"
                className="block text-xs font-mono text-[#D8CFC2] mb-1.5"
              >
                Operator Passphrase
              </label>
              <input
                id="operator-passphrase"
                type="password"
                value={passphraseInput}
                onChange={(e) => setPassphraseInput(e.target.value)}
                placeholder="Minimum 10 characters"
                required
                minLength={status?.operatorClaimed ? 1 : 10}
                className="w-full bg-[#140D0B] border border-[#4A362D] px-3 py-2 text-sm text-[#F2EBE1] rounded-sm focus:outline-none focus:border-[#C83214]"
              />
            </div>

            {!status?.operatorClaimed && (
              <div>
                <label
                  htmlFor="operator-passphrase-confirm"
                  className="block text-xs font-mono text-[#D8CFC2] mb-1.5"
                >
                  Confirm Passphrase
                </label>
                <input
                  id="operator-passphrase-confirm"
                  type="password"
                  value={confirmPassphraseInput}
                  onChange={(e) => setConfirmPassphraseInput(e.target.value)}
                  placeholder="Re-enter passphrase"
                  required
                  minLength={10}
                  className="w-full bg-[#140D0B] border border-[#4A362D] px-3 py-2 text-sm text-[#F2EBE1] rounded-sm focus:outline-none focus:border-[#C83214]"
                />
              </div>
            )}

            {authError && (
              <div role="alert" className="text-xs font-mono text-[#E04819]">
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={authSubmitting}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-[#C83214] hover:bg-[#E04819] disabled:opacity-50 text-[#F7F3EC] rounded-sm transition-colors whitespace-nowrap cursor-pointer"
            >
              <Unlock className="w-3.5 h-3.5" />
              {authSubmitting
                ? 'Verifying...'
                : status?.operatorClaimed
                ? 'Unlock Vault'
                : 'Claim & Unlock Vault'}
            </button>
          </form>
        </section>
      ) : (
        <div className="space-y-4">
          {/* Provider Switcher */}
          <div
            role="tablist"
            aria-label="Provider secret registries"
            className="flex flex-wrap items-center gap-2 border-b border-[#382821] pb-3"
          >
            {PROVIDERS.map((p) => {
              const count = accounts.filter((a) => a.provider === p.id).length;
              const isActive = activeProvider === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => {
                    setActiveProvider(p.id);
                    setSaveFeedback(null);
                    setConfirmDeleteKey(null);
                  }}
                  className={`inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium border rounded-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-[#C83214] text-[#F7F3EC] border-[#E04819]'
                      : 'bg-[#1A110E] text-[#D8CFC2] border-[#3F2E27] hover:border-[#6A4E42] hover:text-[#F7F3EC]'
                  }`}
                >
                  <ProviderIcon provider={p.id} className="w-3.5 h-3.5" />
                  <span>{p.label}</span>
                  <span className="font-mono text-[11px] opacity-85 tabular-nums">({count})</span>
                </button>
              );
            })}
          </div>

          {!status?.supabaseConfigured && (
            <div className="border border-[#8C5B23] bg-[#23190E] px-3.5 py-2 text-xs text-[#F2EBE1] rounded-sm">
              Supabase backend awaiting{' '}
              {requiredEnvVars.map((envVar, idx) => (
                <React.Fragment key={envVar}>
                  {idx > 0 && ' and '}
                  <span className="font-mono text-[#E09F3E]">{envVar}</span>
                </React.Fragment>
              ))}
              . Set these variables in your environment to encrypt and persist{' '}
              {activeProviderMeta.label} secrets to Supabase Vault.
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Write-Only Add / Rotate Secret Form */}
            <section
              aria-labelledby="add-secret-heading"
              className="lg:col-span-5 border border-[#433129] bg-[#211613] p-4 rounded-sm space-y-3"
            >
              <div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-[#DF6B3B]">
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>WRITE-ONLY VAULT ENTRY</span>
                </div>
                <h2 id="add-secret-heading" className="font-display text-base font-semibold text-[#F7F3EC] mt-0.5">
                  Save {activeProviderMeta.label} Secret
                </h2>
                <p className="text-xs text-[#B9AA9D] mt-0.5 leading-snug">
                  {activeProviderMeta.hint}
                </p>
              </div>

              <form onSubmit={handleSaveSecret} className="space-y-3">
                <div>
                  <label
                    htmlFor="provider-alias"
                    className="block text-xs font-mono text-[#D8CFC2] mb-1"
                  >
                    Account Alias
                  </label>
                  <input
                    id="provider-alias"
                    type="text"
                    value={aliasInput}
                    onChange={(e) => setAliasInput(e.target.value.toUpperCase())}
                    placeholder="PRIMARY"
                    required
                    maxLength={48}
                    className="w-full bg-[#140D0B] border border-[#4A362D] px-3 py-1.5 text-sm font-mono text-[#F2EBE1] rounded-sm focus:outline-none focus:border-[#C83214]"
                  />
                  <p className="text-[11px] text-[#9C8A7C] mt-1">
                    Uppercase (A-Z, 0-9, _). Reusing an alias rotates its Vault secret.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="provider-account-id"
                    className="block text-xs font-mono text-[#D8CFC2] mb-1"
                  >
                    {activeProviderMeta.accountIdLabel}
                  </label>
                  <input
                    id="provider-account-id"
                    type="text"
                    value={accountIdInput}
                    onChange={(e) => setAccountIdInput(e.target.value)}
                    placeholder={activeProviderMeta.accountIdPlaceholder}
                    maxLength={128}
                    className="w-full bg-[#140D0B] border border-[#4A362D] px-3 py-1.5 text-sm font-mono text-[#F2EBE1] rounded-sm focus:outline-none focus:border-[#C83214]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="provider-secret-token"
                    className="block text-xs font-mono text-[#D8CFC2] mb-1"
                  >
                    {activeProviderMeta.label} Secret Token
                  </label>
                  <div className="relative">
                    <input
                      ref={tokenInputRef}
                      id="provider-secret-token"
                      type={showCredential ? 'text' : 'password'}
                      value={credentialInput}
                      onChange={(e) => setCredentialInput(e.target.value)}
                      placeholder={activeProviderMeta.tokenPlaceholder}
                      required
                      minLength={16}
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full bg-[#140D0B] border border-[#4A362D] pl-3 pr-10 py-1.5 text-sm font-mono text-[#F2EBE1] rounded-sm focus:outline-none focus:border-[#C83214]"
                    />
                    <button
                      type="button"
                      aria-label={showCredential ? 'Hide secret token' : 'Show secret token'}
                      onClick={() => setShowCredential((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[#A89688] hover:text-[#F7F3EC] cursor-pointer"
                    >
                      {showCredential ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-[#9C8A7C] mt-1">
                    Encrypted on Supabase server; never stored in browser storage.
                  </p>
                </div>

                {saveFeedback && (
                  <div
                    role={saveFeedback.kind === 'error' ? 'alert' : 'status'}
                    className={`px-3 py-2 text-xs font-mono border rounded-sm ${
                      saveFeedback.kind === 'success'
                        ? 'border-[#3E7A56] bg-[#13241A] text-[#6CC48E]'
                        : 'border-[#C83214] bg-[#2B1410] text-[#F7F3EC]'
                    }`}
                  >
                    {saveFeedback.message}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={saveSubmitting || !status?.supabaseConfigured}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold bg-[#C83214] hover:bg-[#E04819] disabled:opacity-50 disabled:cursor-not-allowed text-[#F7F3EC] rounded-sm transition-colors cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4" />
                  {saveSubmitting
                    ? 'Encrypting in Supabase Vault...'
                    : status?.supabaseConfigured
                    ? `Save ${activeProviderMeta.label} Secret`
                    : `Save ${activeProviderMeta.label} Secret (Requires Supabase Data API Config)`}
                </button>
              </form>
            </section>

            {/* Stored Vault Accounts List */}
            <section
              aria-labelledby="vault-accounts-heading"
              className="lg:col-span-7 border border-[#3F2E27] bg-[#1A110E] rounded-sm overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#382821] flex items-center justify-between gap-4">
                <div>
                  <h2 id="vault-accounts-heading" className="font-display text-base font-semibold text-[#F7F3EC]">
                    Stored {activeProviderMeta.label} Secrets
                  </h2>
                  <p className="text-xs text-[#9C8A7C] mt-0.5">
                    Metadata only. Decrypted credentials never leave the server.
                  </p>
                </div>
                <span className="font-mono text-xs text-[#B9AA9D] tabular-nums">
                  {providerAccounts.length} configured
                </span>
              </div>

              {loadingAccounts ? (
                <div className="p-8 text-center text-xs font-mono text-[#B9AA9D]">
                  Loading Supabase Vault registry...
                </div>
              ) : providerAccounts.length === 0 ? (
                <div className="p-8 text-center space-y-2">
                  <p className="text-sm text-[#D8CFC2]">
                    No {activeProviderMeta.label} secrets stored yet.
                  </p>
                  <p className="text-xs text-[#9C8A7C]">
                    Use the form on the left to encrypt and save your first {activeProviderMeta.label}{' '}
                    token directly into Supabase Vault.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-[#352620]">
                  {providerAccounts.map((account) => {
                    const rowKey = `${account.provider}:${account.alias}`;
                    const isBusy = busyKey === rowKey;
                    const isConfirmingDelete = confirmDeleteKey === rowKey;
                    const testResult = testResults[rowKey];

                    return (
                      <div key={account.id} className="p-4 space-y-3 hover:bg-[#211613]/60 transition-colors">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2 font-mono text-xs">
                              <span className="font-semibold text-[#F7F3EC]">{account.alias}</span>
                              <span aria-hidden="true" className="text-[#6B5A4E]">·</span>
                              <span className={account.enabled ? 'text-[#6CC48E]' : 'text-[#E09F3E]'}>
                                {account.enabled ? 'Enabled' : 'Disabled'}
                              </span>
                              {account.accountId && (
                                <>
                                  <span aria-hidden="true" className="text-[#6B5A4E]">·</span>
                                  <span className="text-[#B9AA9D] truncate">
                                    ID: {account.accountId}
                                  </span>
                                </>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-[#9C8A7C] tabular-nums">
                              <span>Vault Encrypted · Hidden</span>
                              {account.updatedAt && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>Updated {new Date(account.updatedAt).toLocaleString()}</span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            <button
                              type="button"
                              aria-label={`Test ${account.provider} ${account.alias}`}
                              disabled={isBusy || !account.enabled}
                              onClick={() => void handleTestAccount(account)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono border border-[#4A362D] bg-[#211613] text-[#DFE4D8] hover:border-[#C83214] disabled:opacity-45 rounded-xs transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 text-[#6CC48E]" />
                              Test
                            </button>

                            <button
                              type="button"
                              aria-label={`Rotate ${account.provider} ${account.alias}`}
                              disabled={isBusy}
                              onClick={() => {
                                setAliasInput(account.alias);
                                setAccountIdInput(account.accountId || '');
                                setCredentialInput('');
                                tokenInputRef.current?.focus();
                              }}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono border border-[#4A362D] bg-[#211613] text-[#D8CFC2] hover:border-[#DF6B3B] rounded-xs transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <RotateCw className="w-3.5 h-3.5" />
                              Rotate
                            </button>

                            <button
                              type="button"
                              aria-label={`${account.enabled ? 'Disable' : 'Enable'} ${account.provider} ${account.alias}`}
                              disabled={isBusy}
                              onClick={() => void handleToggleEnabled(account)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono border border-[#4A362D] bg-[#211613] text-[#D8CFC2] hover:border-[#E09F3E] rounded-xs transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <Power className="w-3.5 h-3.5" />
                              {account.enabled ? 'Disable' : 'Enable'}
                            </button>

                            {isConfirmingDelete ? (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  aria-label={`Confirm delete ${account.provider} ${account.alias}`}
                                  disabled={isBusy}
                                  onClick={() => void handleDeleteAccount(account)}
                                  className="px-2.5 py-1.5 text-[11px] font-mono bg-[#C83214] text-[#F7F3EC] rounded-xs hover:bg-[#E04819] whitespace-nowrap cursor-pointer"
                                >
                                  Confirm Revoke
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteKey(null)}
                                  className="px-2 py-1.5 text-[11px] font-mono border border-[#4A362D] text-[#B9AA9D] rounded-xs hover:text-[#F7F3EC] whitespace-nowrap cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                aria-label={`Delete ${account.provider} ${account.alias}`}
                                disabled={isBusy}
                                onClick={() => setConfirmDeleteKey(rowKey)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono border border-[#4A362D] bg-[#211613] text-[#E04819] hover:border-[#C83214] rounded-xs transition-colors whitespace-nowrap cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Revoke
                              </button>
                            )}
                          </div>
                        </div>

                        {testResult && (
                          <div
                            className={`text-[11px] font-mono px-3 py-1.5 border rounded-xs ${
                              testResult.ok
                                ? 'border-[#3E7A56] bg-[#13241A] text-[#6CC48E]'
                                : 'border-[#8C3B28] bg-[#261410] text-[#E04819]'
                            }`}
                          >
                            {testResult.summary} (HTTP {testResult.statusCode})
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
