import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../scripts/server.mjs';

async function fixture(env={}){
 mkdirSync('.sites-runtime',{recursive:true});const dir=mkdtempSync(resolve('.sites-runtime/server-test-'));
 mkdirSync(join(dir,'assets/portable'),{recursive:true});writeFileSync(join(dir,'assets/portable/index.html'),'<!doctype html><title>LONG Vault</title>');
 const app=await createApp({env:{DATA_DIR:join(dir,'data'),...env},assetDir:join(dir,'assets')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+app.server.address().port;
 return {origin,dir,app,async close(){await app.close();assert.ok(dir.startsWith(resolve('.sites-runtime')+requireSeparator()));rmSync(dir,{recursive:true,force:true});}};
}
function requireSeparator(){return process.platform==='win32'?'\\':'/';}
test('Railway server serves visitors, authenticates admin, persists CA, and rejects unsafe requests',async()=>{
 const password=randomBytes(32).toString('base64url'),keeper=randomBytes(32).toString('base64url');
 const f=await fixture({ADMIN_PASSWORD:password,KEEPER_SECRET:keeper});
 const request=(path,init={})=>fetch(f.origin+path,{redirect:'manual',...init});
 try{
  assert.equal((await request('/health')).status,200);assert.equal((await request('/')).status,200);
  assert.equal((await request('/api/vault', {headers:{'x-chatgpt-user-id':'long_vault_admin'}})).status,401);
  assert.equal((await request('/admin')).status,303);
  assert.equal((await request('/api/public')).status,200);
  assert.equal((await request('/admin/login',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password})})).status,403);
  assert.equal((await request('/admin/login',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:'wrong'})})).status,401);
  const login=await request('/admin/login',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password})});assert.equal(login.status,303);assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:f.origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()};
  const before=await(await request('/api/vault',{headers})).json();const config={...before.config,tokenMint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'};
  const command={method:'POST',headers,body:JSON.stringify({type:'configure',config})};
  assert.equal((await request('/api/vault',{...command,headers:{...headers,Origin:'https://evil.example'}})).status,403);
  assert.equal((await request('/api/vault',command)).status,200);assert.equal((await request('/api/vault',command)).status,200);
  const publicValue=await(await request('/api/public')).json();assert.equal(publicValue.config.tokenMint,config.tokenMint);assert.deepEqual(publicValue.events,[]);assert.equal(publicValue.config.dataSource,'mainnet');assert.equal('ready' in publicValue,false);assert.equal('positions' in publicValue,false);assert.equal(JSON.stringify(publicValue).includes(password),false);
  assert.equal((await request('/api/keeper',{method:'POST'})).status,401);
  assert.equal((await request('/api/keeper',{method:'POST',headers:{Authorization:'Bearer '+keeper,'Idempotency-Key':randomUUID()}})).status,422);
  const monitoring={...config,dataSource:'mainnet'};
  assert.equal((await request('/api/vault',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({type:'configure',config:monitoring})})).status,200);
  const noTrade=await request('/api/vault',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({type:'claim'})});assert.equal(noTrade.status,422);assert.match((await noTrade.json()).error,/read-only/);
  assert.equal((await request('/api/connections',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await request('/api/vault',{method:'POST',headers,body:'{'})).status,400);
  assert.equal((await request('/admin/logout',{method:'POST',headers})).status,303);assert.equal((await request('/api/vault',{headers})).status,401);
  // Restart against the same volume: state survives, sessions do not.
  await f.app.close();const restarted=await createApp({env:{DATA_DIR:join(f.dir,'data'),ADMIN_PASSWORD:password},assetDir:join(f.dir,'assets')});f.app=restarted;await new Promise(r=>restarted.server.listen(0,'127.0.0.1',r));
  const persisted=await(await fetch('http://127.0.0.1:'+restarted.server.address().port+'/api/public')).json();assert.equal(persisted.config.tokenMint,config.tokenMint);await restarted.close();
 }finally{if(f.app.server.listening)await f.app.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('missing admin secret locks admin without taking down the public website',async()=>{
 const f=await fixture();try{assert.equal((await fetch(f.origin+'/')).status,200);assert.equal((await fetch(f.origin+'/admin/login')).status,503);assert.equal((await fetch(f.origin+'/api/vault')).status,401);}finally{await f.close();}
});
test('configured HTTPS origin sets a Secure cookie and rejects origin substitutions',async()=>{
 const password=randomBytes(32).toString('hex'),f=await fixture({ADMIN_PASSWORD:password,PUBLIC_ORIGIN:'https://longcoin.lol'});
 try{const response=await fetch(f.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:'https://longcoin.lol','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password})});assert.equal(response.status,303);assert.match(response.headers.get('set-cookie'),/; Secure/);}finally{await f.close();}
});
