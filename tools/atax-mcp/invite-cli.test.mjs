import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIssue,buildRevoke,createKey} from './invite-cli.mjs';
import {createHash} from 'node:crypto';
test('owner can provision expiring invitations with only token digests in remote D1 SQL',()=>{
 const token=createKey();
 assert.match(token,/^atax_[a-zA-Z0-9_-]{64}$/);
 const sql=buildIssue('guest-principal',['atax:read','atax:github:read'],7,token);
 assert.ok(sql.includes(createHash('sha256').update(token).digest('hex')));
 assert.ok(!sql.includes(token));
 assert.ok(sql.includes("datetime('now','+7 days')"));
 assert.ok(sql.includes('INSERT INTO atax_access_keys'));
});
test('operator CLI denies SQL injection, administrative scopes, indefinite key expiry',()=>{
 const token=createKey();
 assert.throws(()=>buildIssue("bad' OR 1=1 --",['atax:read'],30,token),/Invalid subject/);
 assert.throws(()=>buildIssue('guest-principal',['atax:admin'],30,token),/Invalid invite scopes/);
 assert.throws(()=>buildIssue('guest-principal',['atax:read'],366,token),/expire/);
 assert.throws(()=>buildIssue('guest-principal',['atax:read'],0,token),/expire/);
 assert.throws(()=>buildIssue('guest-principal',['atax:read'],30,'plaintext-password'),/format/);
 assert.throws(()=>buildRevoke("abc'; DELETE FROM atax_principals"),/Invalid subject/);
 const sql=buildRevoke('guest-principal');
 assert.ok(sql.includes('DELETE FROM atax_access_keys'));
 assert.ok(sql.includes('DELETE FROM atax_connections'));
 assert.ok(sql.includes('active=0'));
});
