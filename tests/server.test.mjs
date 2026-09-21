import {Keypair} from '@solana/web3.js';
import {developerWalletStatus} from '../.sites-runtime/lib/dev-wallet.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {walletSecrets} from '../scripts/wallet-secrets.mjs';
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

test('Railway custom domain accepts its own origin without pinning the generated domain',async()=>{
 const password=randomBytes(32).toString('hex');
 const f=await fixture({ADMIN_PASSWORD:password,RAILWAY_ENVIRONMENT_ID:'production',RAILWAY_PUBLIC_DOMAIN:'generated.up.railway.app'});
 try{
  const send=origin=>fetch(f.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password})});
  assert.equal((await send('https://evil.example')).status,403);
  const response=await send(f.origin.replace('http:','https:'));assert.equal(response.status,303);assert.match(response.headers.get('set-cookie'),/; Secure/);
 }finally{await f.close();}
});
test('invalid admin configuration explains setup without offering a broken login form',async()=>{
 for(const password of ['', 'short', 'x'.repeat(257)]){
  const f=await fixture({ADMIN_PASSWORD:password});
  try{const response=await fetch(f.origin+'/admin/login');assert.equal(response.status,503);const html=await response.text();assert.match(html,/ADMIN_PASSWORD/);assert.doesNotMatch(html,/<form/);}finally{await f.close();}
 }
});

test('developer wallet validates secrets without exposing them in responses',async()=>{
 const wallet=Keypair.generate(),publicKey=wallet.publicKey.toBase58(),secret=JSON.stringify([...wallet.secretKey]);
 assert.equal(developerWalletStatus(secret,publicKey,publicKey).status,'configured');
 let n=0n;for(const b of wallet.secretKey)n=n*256n+BigInt(b);let encoded='';const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';while(n){encoded=alphabet[Number(n%58n)]+encoded;n/=58n;}for(const b of wallet.secretKey){if(b!==0)break;encoded='1'+encoded;}
 assert.equal(developerWalletStatus(encoded).publicKey,publicKey);
 assert.equal(developerWalletStatus(secret,Keypair.generate().publicKey.toBase58()).status,'mismatch');
 assert.equal(developerWalletStatus('not a valid secret').status,'invalid');
 assert.equal(developerWalletStatus(JSON.stringify(Array(64).fill(0))).status,'invalid');
 const password=randomBytes(32).toString('hex'),f=await fixture({ADMIN_PASSWORD:password,DEV_WALLET_PRIVATE_KEY:secret});
 try{
  const publicData=await(await fetch(f.origin+'/api/public')).text();assert.equal(publicData.includes(secret),false);assert.equal(publicData.includes('developerWallet'),false);
  const login=await fetch(f.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password})});
  const response=await fetch(f.origin+'/api/vault',{headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}});const text=await response.text();assert.equal(text.includes(secret),false);assert.equal(JSON.parse(text).developerWallet.publicKey,publicKey);
 }finally{await f.close();}
});

test('admin setup encrypts the key, unifies wallet addresses, and persists without returning secrets',async()=>{
 const password=randomBytes(32).toString('hex'),wallet=Keypair.generate(),privateKey=JSON.stringify([...wallet.secretKey]);
 const f=await fixture({ADMIN_PASSWORD:password});
 try{
  const login=await fetch(f.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password})});
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0],Origin:f.origin,'Content-Type':'application/json'};
  const input={tokenMint:'So11111111111111111111111111111111111111112',privateKey,cycleSeconds:180};
  assert.equal((await fetch(f.origin+'/api/setup',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(input)})).status,403);
  assert.equal((await fetch(f.origin+'/api/setup',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify(input)})).status,401);
  const result=await fetch(f.origin+'/api/setup',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(result.status,200);const text=await result.text();assert.equal(text.includes(privateKey),false);
  const {config}=JSON.parse(text);assert.equal(config.vault,wallet.publicKey.toBase58());assert.equal(config.creator,config.vault);assert.equal(config.treasury,config.vault);assert.equal(config.cooldownSeconds,180);
  const db=new DatabaseSync(join(f.dir,'data/vault.sqlite'));const stored=db.prepare('SELECT ciphertext FROM developer_secret').get();assert.equal(stored.ciphertext.includes(privateKey),false);assert.equal(walletSecrets(db,{DATA_DIR:join(f.dir,'data')}).read(),privateKey);
  const damaged=JSON.parse(stored.ciphertext);damaged.tag=Buffer.alloc(16).toString('base64');db.prepare('UPDATE developer_secret SET ciphertext=?').run(JSON.stringify(damaged));assert.throws(()=>walletSecrets(db,{DATA_DIR:join(f.dir,'data')}).read(),/cannot be decrypted/);db.close();
  const publicData=await(await fetch(f.origin+'/api/public')).text();assert.equal(publicData.includes(privateKey),false);assert.equal(publicData.includes('ciphertext'),false);
  assert.equal((await fetch(f.origin+'/api/trading',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify({kind:'resume'})})).status,403);
  const disabled=await fetch(f.origin+'/api/trading',{method:'POST',headers,body:JSON.stringify({kind:'resume'})});assert.equal(disabled.status,422);assert.match((await disabled.json()).error,/LIVE_TRADING_ENABLED/);
 }finally{await f.close();}
});
