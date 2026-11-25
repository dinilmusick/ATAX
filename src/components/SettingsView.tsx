import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {CheckCircle2,Cloud,Database,Eye,EyeOff,GitBranch,KeyRound,Lock,RefreshCw,RotateCw,ShieldCheck,Trash2,Unlock,Power} from 'lucide-react';
import type {ProviderAccountSummary,ProviderTestResult,ProviderType,SettingsStatusResponse} from '../types/substrate';

interface SettingsViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading:boolean)=>void;
}

const PROVIDERS:Array<{
  id: Exclude<ProviderType,'vercel'>;
  label:string;
  accountIdLabel:string;
  accountIdPlaceholder:string;
  tokenPlaceholder:string;
  hint:string;
}>=[
  {
    id:'github',
    label:'GitHub',
    accountIdLabel:'GitHub Owner / Organization',
    accountIdPlaceholder:'owner-or-org',
    tokenPlaceholder:'github_pat_... or ghp_...',
    hint:'Stored in Supabase Vault and used server-side for GitHub operations.',
  },
  {
    id:'cloudflare',
    label:'Cloudflare',
    accountIdLabel:'Cloudflare Account ID',
    accountIdPlaceholder:'32-character account identifier',
    tokenPlaceholder:'Cloudflare API token...',
    hint:'Stored in Supabase Vault and used server-side for Cloudflare operations.',
  },
];

function ProviderIcon({provider,className='w-4 h-4'}:{provider:ProviderType;className?:string}){
  return provider==='github'
    ? <GitBranch className={className}/>
    : <Cloud className={className}/>;
}

async function jsonResponse<T>(response:Response):Promise<T>{
  const text=await response.text();
  if(!text.trim()) return {} as T;
  try{return JSON.parse(text) as T;}
  catch{return {} as T;}
}

export function SettingsView({refreshTick=0,onLoadingChange}:SettingsViewProps){
  const [status,setStatus]=useState<SettingsStatusResponse|null>(null);
  const [loadingStatus,setLoadingStatus]=useState(true);
  const [statusError,setStatusError]=useState<string|null>(null);
  const [passkey,setPasskey]=useState('');
  const [unlocking,setUnlocking]=useState(false);
  const [authError,setAuthError]=useState<string|null>(null);

  const [activeProvider,setActiveProvider]=useState<Exclude<ProviderType,'vercel'>>('github');
  const [accounts,setAccounts]=useState<ProviderAccountSummary[]>([]);
  const [loadingAccounts,setLoadingAccounts]=useState(false);
  const [aliasInput,setAliasInput]=useState('');
  const [accountIdInput,setAccountIdInput]=useState('');
  const [credentialInput,setCredentialInput]=useState('');
  const [showCredential,setShowCredential]=useState(false);
  const [saveSubmitting,setSaveSubmitting]=useState(false);
  const [saveFeedback,setSaveFeedback]=useState<{kind:'success'|'error';message:string}|null>(null);
  const [busyKey,setBusyKey]=useState<string|null>(null);
  const [confirmDeleteKey,setConfirmDeleteKey]=useState<string|null>(null);
  const [testResults,setTestResults]=useState<Record<string,ProviderTestResult>>({});
  const credentialRef=useRef<HTMLInputElement|null>(null);

  const loadStatus=useCallback(async()=>{
    setLoadingStatus(true);
    onLoadingChange?.(true);
    setStatusError(null);
    try{
      const res=await fetch('/api/settings/status',{cache:'no-store'});
      const data=await jsonResponse<SettingsStatusResponse & {error?:string}>(res);
      if(!res.ok&&data?.backend===undefined) throw new Error(data.error||`Status unavailable (HTTP ${res.status})`);
      setStatus(data);
      if(res.status>=500&&!data.backend?.reachable) setStatusError('Settings backend is currently unavailable.');
    }catch(err){
      setStatusError(err instanceof Error?err.message:'Unable to reach settings backend.');
    }finally{
      setLoadingStatus(false);
      onLoadingChange?.(false);
    }
  },[onLoadingChange]);

  const authenticated=Boolean(status?.authentication.authenticated);

  const loadAccounts=useCallback(async()=>{
    if(!authenticated){setAccounts([]);return;}
    setLoadingAccounts(true);
    try{
      const res=await fetch('/api/settings/providers',{cache:'no-store'});
      const data=await jsonResponse<{accounts?:ProviderAccountSummary[];error?:string}>(res);
      if(res.status===401){await loadStatus();return;}
      if(!res.ok) throw new Error(data.error||`Provider registry unavailable (HTTP ${res.status})`);
      setAccounts(Array.isArray(data.accounts)?data.accounts:[]);
    }catch(err){
      setSaveFeedback({kind:'error',message:err instanceof Error?err.message:'Unable to load provider accounts.'});
    }finally{setLoadingAccounts(false);}
  },[authenticated,loadStatus]);

  useEffect(()=>{void loadStatus();},[loadStatus,refreshTick]);
  useEffect(()=>{void loadAccounts();},[loadAccounts,refreshTick]);

  const handleUnlock=async(event:React.FormEvent)=>{
    event.preventDefault();
    setAuthError(null);
    if(passkey.length<12){setAuthError('Passkey must be at least 12 characters.');return;}
    setUnlocking(true);
    try{
      const res=await fetch('/api/settings/auth/unlock',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({passkey}),
      });
      const data=await jsonResponse<{error?:string}>(res);
      if(!res.ok) throw new Error(data.error||'Authentication failed.');
      setPasskey('');
      await loadStatus();
    }catch(err){
      setAuthError(err instanceof Error?err.message:'Unable to unlock the ATAX instance.');
    }finally{setUnlocking(false);}
  };

  const handleLock=async()=>{
    await fetch('/api/settings/auth/logout',{method:'POST'}).catch(()=>undefined);
    setAccounts([]);
    setCredentialInput('');
    setPasskey('');
    setSaveFeedback(null);
    await loadStatus();
  };

  const handleSave=async(event:React.FormEvent)=>{
    event.preventDefault();
    setSaveFeedback(null);
    const alias=aliasInput.trim().toUpperCase();
    if(!/^[A-Z][A-Z0-9_]{0,47}$/.test(alias)){
      setSaveFeedback({kind:'error',message:'Alias must start with A-Z and use only uppercase letters, numbers, or underscores.'});
      return;
    }
    if(credentialInput.trim().length<16){
      setSaveFeedback({kind:'error',message:'Credential must be at least 16 characters.'});
      return;
    }

    setSaveSubmitting(true);
    try{
      const res=await fetch('/api/settings/providers',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          provider:activeProvider,
          alias,
          accountId:accountIdInput.trim()||null,
          credential:credentialInput.trim(),
          enabled:true,
        }),
      });
      const data=await jsonResponse<{error?:string}>(res);
      if(res.status===401){await loadStatus();throw new Error('Instance authentication expired.');}
      if(!res.ok) throw new Error(data.error||`Save failed (HTTP ${res.status})`);
      setCredentialInput('');
      setShowCredential(false);
      setSaveFeedback({kind:'success',message:`Saved ${activeProvider} / ${alias} to Supabase Vault.`});
      await loadAccounts();
    }catch(err){
      setSaveFeedback({kind:'error',message:err instanceof Error?err.message:'Unable to save provider credential.'});
    }finally{setSaveSubmitting(false);}
  };

  const rotateAccount=(account:ProviderAccountSummary)=>{
    setActiveProvider(account.provider as Exclude<ProviderType,'vercel'>);
    setAliasInput(account.alias);
    setAccountIdInput(account.accountId||'');
    setCredentialInput('');
    setShowCredential(false);
    setSaveFeedback({kind:'success',message:`Enter the replacement credential for ${account.alias}; saving the same alias rotates the Vault secret.`});
    setTimeout(()=>credentialRef.current?.focus(),0);
  };

  const toggleAccount=async(account:ProviderAccountSummary)=>{
    const key=`${account.provider}:${account.alias}`;
    setBusyKey(key);
    setSaveFeedback(null);
    try{
      const res=await fetch(`/api/settings/providers/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.alias)}/enabled`,{
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({enabled:!account.enabled}),
      });
      const data=await jsonResponse<{error?:string}>(res);
      if(res.status===401){await loadStatus();throw new Error('Instance authentication expired.');}
      if(!res.ok) throw new Error(data.error||'Failed to update provider state.');
      await loadAccounts();
    }catch(err){setSaveFeedback({kind:'error',message:err instanceof Error?err.message:'Unable to update provider state.'});}
    finally{setBusyKey(null);}
  };

  const deleteAccount=async(account:ProviderAccountSummary)=>{
    const key=`${account.provider}:${account.alias}`;
    setBusyKey(key);
    try{
      const res=await fetch(`/api/settings/providers/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.alias)}`,{method:'DELETE'});
      const data=await jsonResponse<{error?:string}>(res);
      if(res.status===401){await loadStatus();throw new Error('Instance authentication expired.');}
      if(!res.ok) throw new Error(data.error||'Failed to revoke provider credential.');
      setConfirmDeleteKey(null);
      setSaveFeedback({kind:'success',message:`Revoked ${account.provider} / ${account.alias}.`});
      await loadAccounts();
    }catch(err){setSaveFeedback({kind:'error',message:err instanceof Error?err.message:'Unable to revoke provider credential.'});}
    finally{setBusyKey(null);}
  };

  const testAccount=async(account:ProviderAccountSummary)=>{
    const key=`${account.provider}:${account.alias}`;
    setBusyKey(key);
    try{
      const res=await fetch(`/api/settings/providers/${encodeURIComponent(account.provider)}/${encodeURIComponent(account.alias)}/test`,{method:'POST'});
      const data=await jsonResponse<ProviderTestResult & {error?:string}>(res);
      if(res.status===401){await loadStatus();throw new Error('Instance authentication expired.');}
      if(!res.ok) throw new Error(data.error||'Provider connection test failed.');
      setTestResults(prev=>({...prev,[key]:data}));
    }catch(err){
      setTestResults(prev=>({...prev,[key]:{ok:false,provider:account.provider,alias:account.alias,statusCode:500,summary:err instanceof Error?err.message:'Provider test failed.',checkedAt:new Date().toISOString()}}));
    }finally{setBusyKey(null);}
  };

  const activeProviderMeta=useMemo(()=>PROVIDERS.find(p=>p.id===activeProvider)!,[activeProvider]);
  const providerAccounts=accounts.filter(account=>account.provider===activeProvider);

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 border-b border-[#382821] pb-3.5">
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight text-[#F7F3EC]">Vault &amp; Environment Settings</h1>
          <p className="text-xs text-[#B9AA9D] mt-0.5 max-w-2xl">
            One ATAX instance passkey protects the management plane. Provider credentials remain server-side in Supabase Vault.
          </p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {authenticated&&(
            <button type="button" onClick={()=>void handleLock()} className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-[#4A362D] bg-[#211613] text-[#F2EBE1] hover:border-[#C83214] rounded-sm transition-colors">
              <Lock className="w-3.5 h-3.5 text-[#E04819]"/>Lock Vault
            </button>
          )}
          <button type="button" onClick={()=>void loadStatus()} className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-[#3F2E27] bg-[#1A110E] text-[#D8CFC2] hover:text-[#F7F3EC] rounded-sm">
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus?'animate-spin':''}`}/>Refresh Status
          </button>
        </div>
      </div>

      {statusError&&<div role="alert" className="border border-[#C83214] bg-[#2B1410] px-4 py-2.5 text-xs text-[#F7F3EC] rounded-sm">{statusError}</div>}

      <section className="border border-[#3F2E27] bg-[#1A110E] px-4 py-3.5 rounded-sm">
        <div className="flex items-center gap-2 text-[11px] font-mono text-[#A89688]">
          <Database className="w-3.5 h-3.5 text-[#DF6B3B]"/>
          <span>BACKEND</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-2 text-[#D8CFC2]">
            <span className={`w-2 h-2 rounded-full ${status?.backend.reachable?'bg-green-500':'bg-[#6A4E42]'}`}/>
            {status?.backend.reachable?'Supabase Data API reachable':'Backend unavailable'}
          </span>
          <span className="text-[#7D6C61]">·</span>
          <span className="text-[#A89688]">Providers: GitHub + Cloudflare</span>
        </div>
      </section>

      {!authenticated?(
        <section className="border border-[#4A362D] bg-[#211613] px-5 py-5 rounded-sm max-w-xl">
          <div className="flex items-center gap-2 text-[11px] font-mono text-[#A89688]">
            <KeyRound className="w-3.5 h-3.5 text-[#DF6B3B]"/>
            INSTANCE MANAGEMENT AUTHENTICATION
          </div>
          <h2 className="mt-2 text-lg font-semibold text-[#F7F3EC]">Enter passkey</h2>
          <p className="text-xs text-[#A89688] mt-1">This unlocks the single management identity for this ATAX instance.</p>
          <form onSubmit={handleUnlock} className="mt-4 space-y-3">
            <input
              aria-label="Enter passkey"
              type="password"
              autoComplete="current-password"
              value={passkey}
              onChange={e=>setPasskey(e.target.value)}
              placeholder="Enter passkey"
              className="w-full px-3 py-2 text-sm border border-[#4A362D] bg-[#160E0C] text-[#F7F3EC] rounded-sm outline-none focus:border-[#DF6B3B]"
            />
            <button type="submit" disabled={unlocking||!status?.backend.reachable} className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#C94A1B] text-white rounded-sm disabled:opacity-50">
              {unlocking?<RefreshCw className="w-3.5 h-3.5 animate-spin"/>:<Unlock className="w-3.5 h-3.5"/>}
              Unlock
            </button>
          </form>
          {authError&&<div className="mt-3 text-xs text-[#FF9A7B]">{authError}</div>}
        </section>
      ):(
        <>
          <section className="border border-[#3F2E27] bg-[#1A110E] px-4 py-3.5 rounded-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-[#A89688]"><ShieldCheck className="w-3.5 h-3.5 text-green-500"/>INSTANCE STATUS</div>
                <div className="mt-1 text-sm font-semibold text-[#F7F3EC]">Instance: Unlocked</div>
              </div>
              <div className="text-xs text-[#A89688]">Management session expires automatically and is revocable server-side.</div>
            </div>
          </section>

          <section className="border border-[#3F2E27] bg-[#1A110E] rounded-sm overflow-hidden">
            <div className="flex flex-wrap gap-2 p-3 border-b border-[#3F2E27]">
              {PROVIDERS.map(provider=>(
                <button
                  key={provider.id}
                  type="button"
                  onClick={()=>setActiveProvider(provider.id)}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded-sm border ${activeProvider===provider.id?'border-[#DF6B3B] bg-[#291711] text-[#F7F3EC]':'border-[#3F2E27] text-[#A89688]'}`}
                >
                  <ProviderIcon provider={provider.id}/>{provider.label}
                </button>
              ))}
            </div>

            <div className="p-4">
              <div className="flex items-start gap-3">
                <div className="p-2 border border-[#3F2E27] bg-[#211613] rounded-sm"><ProviderIcon provider={activeProvider} className="w-5 h-5 text-[#DF6B3B]"/></div>
                <div>
                  <h2 className="text-sm font-semibold text-[#F7F3EC]">{activeProviderMeta.label} provider account registry</h2>
                  <p className="text-xs text-[#A89688] mt-0.5">{activeProviderMeta.hint}</p>
                </div>
              </div>

              <form onSubmit={handleSave} className="mt-4 grid md:grid-cols-3 gap-3">
                <label className="text-xs text-[#B9AA9D]">
                  Account Alias
                  <input value={aliasInput} onChange={e=>setAliasInput(e.target.value)} className="mt-1 w-full px-3 py-2 border border-[#4A362D] bg-[#160E0C] text-[#F7F3EC] rounded-sm" placeholder="PRIMARY"/>
                </label>
                <label className="text-xs text-[#B9AA9D]">
                  {activeProviderMeta.accountIdLabel}
                  <input value={accountIdInput} onChange={e=>setAccountIdInput(e.target.value)} className="mt-1 w-full px-3 py-2 border border-[#4A362D] bg-[#160E0C] text-[#F7F3EC] rounded-sm" placeholder={activeProviderMeta.accountIdPlaceholder}/>
                </label>
                <label className="text-xs text-[#B9AA9D]">
                  Credential
                  <div className="relative mt-1">
                    <input ref={credentialRef} type={showCredential?'text':'password'} autoComplete="new-password" value={credentialInput} onChange={e=>setCredentialInput(e.target.value)} className="w-full px-3 py-2 pr-9 border border-[#4A362D] bg-[#160E0C] text-[#F7F3EC] rounded-sm" placeholder={activeProviderMeta.tokenPlaceholder}/>
                    <button type="button" onClick={()=>setShowCredential(v=>!v)} className="absolute right-2 top-2 text-[#8F7B70]">{showCredential?<EyeOff className="w-4 h-4"/>:<Eye className="w-4 h-4"/>}</button>
                  </div>
                </label>
                <div className="md:col-span-3 flex items-center gap-2">
                  <button type="submit" disabled={saveSubmitting} className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#C94A1B] text-white rounded-sm disabled:opacity-50">
                    <KeyRound className="w-3.5 h-3.5"/>Save / Rotate Credential
                  </button>
                  <button type="button" onClick={()=>{setAliasInput('');setAccountIdInput('');setCredentialInput('');setSaveFeedback(null);}} className="px-3 py-2 text-xs border border-[#3F2E27] text-[#A89688] rounded-sm">Clear</button>
                </div>
              </form>

              {saveFeedback&&<div className={`mt-3 text-xs ${saveFeedback.kind==='success'?'text-[#8CD48C]':'text-[#FF9A7B]'}`}>{saveFeedback.message}</div>}

              <div className="mt-5 border-t border-[#3F2E27] pt-4">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-mono text-[#A89688]">REGISTERED ACCOUNTS</div>
                  {loadingAccounts&&<RefreshCw className="w-3.5 h-3.5 animate-spin text-[#8F7B70]"/>}
                </div>
                {providerAccounts.length===0&&!loadingAccounts&&<div className="mt-3 text-xs text-[#7D6C61]">No {activeProviderMeta.label} accounts registered.</div>}
                <div className="mt-3 space-y-2">
                  {providerAccounts.map(account=>{
                    const key=`${account.provider}:${account.alias}`;
                    const result=testResults[key];
                    return (
                      <div key={key} className="border border-[#3F2E27] bg-[#160E0C] rounded-sm p-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2 text-sm text-[#F7F3EC]">
                              <span className="font-mono">{account.alias}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${account.enabled?'border-green-700 text-green-300':'border-[#6A4E42] text-[#A89688]'}`}>{account.enabled?'ENABLED':'DISABLED'}</span>
                            </div>
                            <div className="text-[11px] text-[#8F7B70] mt-1">Provider account ID: {account.accountId||'not supplied'}</div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button type="button" disabled={busyKey===key} onClick={()=>void testAccount(account)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] border border-[#4A362D] text-[#D8CFC2] rounded-sm"><CheckCircle2 className="w-3.5 h-3.5"/>Test</button>
                            <button type="button" disabled={busyKey===key} onClick={()=>rotateAccount(account)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] border border-[#4A362D] text-[#D8CFC2] rounded-sm"><RotateCw className="w-3.5 h-3.5"/>Rotate</button>
                            <button type="button" disabled={busyKey===key} onClick={()=>void toggleAccount(account)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] border border-[#4A362D] text-[#D8CFC2] rounded-sm"><Power className="w-3.5 h-3.5"/>{account.enabled?'Disable':'Enable'}</button>
                            {confirmDeleteKey===key?(
                              <>
                                <button type="button" onClick={()=>void deleteAccount(account)} className="px-2.5 py-1.5 text-[11px] border border-[#C83214] text-[#FF9A7B] rounded-sm">Confirm Revoke</button>
                                <button type="button" onClick={()=>setConfirmDeleteKey(null)} className="px-2.5 py-1.5 text-[11px] border border-[#3F2E27] text-[#A89688] rounded-sm">Cancel</button>
                              </>
                            ):(
                              <button type="button" disabled={busyKey===key} onClick={()=>setConfirmDeleteKey(key)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] border border-[#4A362D] text-[#FF9A7B] rounded-sm"><Trash2 className="w-3.5 h-3.5"/>Revoke</button>
                            )}
                          </div>
                        </div>
                        {result&&<div className={`mt-2 text-[11px] ${result.ok?'text-[#8CD48C]':'text-[#FF9A7B]'}`}>{result.summary} · HTTP {result.statusCode}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
