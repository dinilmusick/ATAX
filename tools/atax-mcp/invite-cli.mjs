/** Operator-side invitation management; never callable from the shared MCP endpoint.
 * Usage (trusted local machine; never CI):
 *  node tools/atax-mcp/invite-cli.mjs issue <subject> <comma-separated-scopes> [days-valid]
 *  node tools/atax-mcp/invite-cli.mjs revoke <subject>
 * Requires authenticated Wrangler access to the selected ATAX Cloudflare account.
 */
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {INVITABLE_SCOPES} from './tenant-store.mjs';
const VALID_SUBJECT=/^[\w.@:-]{3,120}$/;
const validScopes=new Set(INVITABLE_SCOPES);
const sqlQuote=v=>"'"+String(v).replaceAll("'","''")+"'";
const fail=m=>{throw Error(m)};
export function buildIssue(subject,scopes,days,token){
 if(!VALID_SUBJECT.test(subject))fail('Invalid subject identifier');
 if(!Array.isArray(scopes)||!scopes.length||scopes.some(s=>!validScopes.has(s)))fail('Invalid invite scopes');
 if(!Number.isInteger(days)||days<1||days>365)fail('Invitation key must expire within 1..365 days');
 if(!/^atax_[a-zA-Z0-9_-]{56,128}$/.test(token))fail('Invalid invitation key format');
 const digest=createHash('sha256').update(token).digest('hex');
 const granted=JSON.stringify([...new Set(scopes)]);
 return `INSERT INTO atax_principals(subject,active,scopes) VALUES(${sqlQuote(subject)},1,${sqlQuote(granted)}) ON CONFLICT(subject) DO UPDATE SET active=1,scopes=excluded.scopes,updated_at=CURRENT_TIMESTAMP;
INSERT INTO atax_access_keys(key_hash,subject,scopes,active,label,expires_at) VALUES(${sqlQuote(digest)},${sqlQuote(subject)},${sqlQuote(granted)},1,'operator-issued',datetime('now','+${days} days'));`;
}
export function buildRevoke(subject){
 if(!VALID_SUBJECT.test(subject))fail('Invalid subject identifier');
 const q=sqlQuote(subject);
 return `DELETE FROM atax_access_keys WHERE subject=${q};DELETE FROM atax_connections WHERE subject=${q};UPDATE atax_principals SET active=0,updated_at=CURRENT_TIMESTAMP WHERE subject=${q};`;
}
export function createKey(){return 'atax_'+randomBytes(48).toString('base64url');}
export function runRemote(sql){
 const config=fileURLToPath(new URL('./wrangler.toml',import.meta.url));
 execFileSync('npx',['--yes','wrangler@4','d1','execute','atax-mcp-tenants','--remote','--config',config,'--command',sql],{stdio:'inherit',timeout:120000});
}
async function main(){
 const [, ,operation,subject,requested,ttl]=process.argv;
 if(operation==='issue'){
  const scopes=String(requested||'').split(',').map(s=>s.trim()).filter(Boolean);
  const days=ttl===undefined?30:Number(ttl);
  const key=createKey(),sql=buildIssue(subject,scopes,days,key);
  runRemote(sql);
  // Never emit the key before D1 confirms the registration.
  process.stdout.write('\nATAX MCP URL: https://atax-mcp.dextro1n1laevo.workers.dev/mcp\n');
  process.stdout.write('Private setup page: https://atax-mcp.dextro1n1laevo.workers.dev/setup\n');
  process.stdout.write('One-time invitation access key (send ONLY to the verified recipient): '+key+'\n');
  process.stdout.write('Expires after '+days+' day(s). Never log this key in CI or send through public channels.\n');
 }else if(operation==='revoke'){
  if(requested!==undefined||ttl!==undefined)fail('Too many arguments for revoke');
  runRemote(buildRevoke(subject));
  process.stdout.write('Revocation executed for '+subject+'. Check D1 independently.\n');
 }else{
  fail('Usage: issue <subject> <comma-separated-scopes> [days] OR revoke <subject>');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{process.stderr.write('Invite management failed: '+e.message+'\n');process.exitCode=1;});
}
