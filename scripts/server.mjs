// Railway / ordinary Node host. This server never trusts Sites/ChatGPT identity headers.
import {createServer} from 'node:http';
import {readFileSync,statSync} from 'node:fs';
import {resolve,relative,extname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash,timingSafeEqual,scrypt as scryptCallback} from 'node:crypto';
import {promisify} from 'node:util';
import {openStore} from './sqlite-store.mjs';
import {readVault,command,publicState} from '../.sites-runtime/lib/store.mjs';
import {connectionReport} from '../.sites-runtime/lib/connections.mjs';
import {previewMainnet} from '../.sites-runtime/lib/mainnet.mjs';

import {developerWalletStatus} from '../.sites-runtime/lib/dev-wallet.mjs';
import {createLivePerps} from './live-perps.mjs';
import {walletSecrets} from './wallet-secrets.mjs';
import {validateConfig} from '../.sites-runtime/lib/engine.mjs';
import {isPublicKey} from '../.sites-runtime/lib/address.mjs';

const scrypt=promisify(scryptCallback);
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
const securityHeaders={'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
const loginHtml=(message='',locked=false)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin · LONG Vault</title><link rel="icon" href="/long-pfp.png"><style>body{margin:0;background:#080c07;color:#edf5ea;font:15px system-ui;display:grid;place-items:center;min-height:100vh}main{width:min(360px,calc(100% - 48px))}h1{font-size:36px;margin-bottom:8px}p{color:#9da996;line-height:1.6}label{display:block;margin-top:28px}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:10px;border:1px solid #304526;border-radius:10px;font:inherit}input{background:#10180c;color:white}button{background:#2dd409;color:#081006;font-weight:700;cursor:pointer}a{color:#a9bb9e;text-decoration:none}.error{color:#eea485}</style></head><body><main><a href="/">← Back to $LONG</a><h1>Admin access</h1><p>Sign in to configure the vault.</p>${message?'<p class="error" role="alert">'+message+'</p>':''}${locked?'':`<form method="post" action="/admin/login"><label for="password">Admin password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">Sign in</button></form>`}</main></body></html>`;

export async function createApp(options={}){
 const env={...(options.env||process.env)};
 const root=resolve(options.assetDir||'.sites-runtime/preview');
 const originValue=env.PUBLIC_ORIGIN||'';
 let expectedOrigin='';if(originValue){const u=new URL(originValue);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('PUBLIC_ORIGIN must be an origin, e.g. https://longcoin.lol');if(u.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('PUBLIC_ORIGIN must use HTTPS outside localhost');expectedOrigin=u.origin;}
 const owner=env.VAULT_OWNER_ID||'long_vault_admin';
 const password=env.ADMIN_PASSWORD||'';const authConfigured=password.length>=20&&password.length<=256;
 const salt=randomBytes(32),digest=authConfigured?await scrypt(password,salt,32):null;
 const {sqlite,db}=openStore(resolve(env.DATA_DIR||'.sites-runtime/data','vault.sqlite'));
 const secrets=walletSecrets(sqlite,env);let walletStorageError='';
 try{const stored=secrets.read();if(stored)env.DEV_WALLET_PRIVATE_KEY=stored;}catch{env.DEV_WALLET_PRIVATE_KEY='';walletStorageError='Stored wallet could not be unlocked. Restore the wallet encryption key or save the wallet again.';}
 const sessions=new Map();let loginWindow=Date.now(),loginAttempts=0,previewInFlight=false;
 const config=async()=>JSON.parse((await readVault(owner,db)).state).config;
 const live=createLivePerps({sqlite,env,config});
 let setupBusy=false;
 const cookieName='long_session';
 const authenticated=req=>{const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);if(!token)return false;const key=hash(token),expires=sessions.get(key);if(!expires)return false;if(expires<Date.now()){sessions.delete(key);return false;}return true;};
 const sameOrigin=req=>{
  // Prefer an explicit domain. Railway terminates TLS; its Host is used only for
  // origin matching when PUBLIC_ORIGIN is absent. Identity never comes from proxy headers.
  const fallback=env.RAILWAY_ENVIRONMENT_ID?'https://'+req.headers.host:'http://'+req.headers.host;
  return req.headers.origin===(expectedOrigin||fallback);
 };
 async function body(req,limit=8192){let value='';for await(const chunk of req){value+=chunk;if(Buffer.byteLength(value)>limit)throw Object.assign(Error('Request too large'),{status:413});}return value;}
 const server=createServer(async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{...securityHeaders,'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const html=(status,value)=>{res.writeHead(status,{...securityHeaders,'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(value);};
  const redirect=(location,cookie)=>{res.writeHead(303,{...securityHeaders,'Cache-Control':'no-store',Location:location,...(cookie?{'Set-Cookie':cookie}:{})});res.end();};
  const requirePost=()=>{if(req.method!=='POST'){send(405,{error:'Method not allowed'});return false;}if(!sameOrigin(req)){send(403,{error:'Same-origin requests only. Check PUBLIC_ORIGIN.'});return false;}return true;};
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/health'){sqlite.prepare('SELECT 1').get();return send(200,{ok:true});}
   if(url.pathname==='/signin-with-chatgpt')return redirect('/admin/login');
   if(url.pathname==='/admin/login'){
    if(!authConfigured)return html(503,loginHtml('Admin is locked. Set ADMIN_PASSWORD to a password of 20-256 characters in Railway / long-vault / Variables, then deploy the changes. This is the app password, not your Railway account password.',true));
    if(req.method==='GET')return html(200,loginHtml());
    if(!requirePost())return;
    if(!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))return send(415,{error:'Form required'});
    if(Date.now()-loginWindow>60000){loginWindow=Date.now();loginAttempts=0;}
    if(++loginAttempts>10)return html(429,loginHtml('Too many attempts. Try again in one minute.'));
    const attempted=new URLSearchParams(await body(req,2048)).get('password')||'';
    const candidate=await scrypt(attempted.slice(0,256),salt,32);
    if(attempted.length>256||!timingSafeEqual(candidate,digest))return html(401,loginHtml('Incorrect password.'));
    const token=randomBytes(32).toString('base64url');
    for(const [key,expiry] of sessions)if(expiry<Date.now())sessions.delete(key);
    if(sessions.size>=100)sessions.delete(sessions.keys().next().value);
    sessions.set(hash(token),Date.now()+8*60*60*1000);
    const secure=expectedOrigin.startsWith('https:')||!!env.RAILWAY_ENVIRONMENT_ID;
    return redirect('/admin',cookieName+'='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800'+(secure?'; Secure':''));
   }
   if(url.pathname==='/admin/logout'){
    if(!requirePost())return;const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);if(token)sessions.delete(hash(token));
    return redirect('/',cookieName+'=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'+(expectedOrigin.startsWith('https:')||env.RAILWAY_ENVIRONMENT_ID?'; Secure':''));
   }
   if(url.pathname==='/api/public'){
    if(req.method!=='GET')return send(405,{error:'Method not allowed'});
    const state=publicState(JSON.parse((await readVault(owner,db)).state)),trading=await live.status();return send(200,{...state,events:[],owner:'',trading:{enabled:trading.enabled,paused:trading.paused,phase:trading.cycle.phase,nextAt:trading.cycle.nextAt||0}});
   }
   if(url.pathname==='/api/trading'){
    if(!authenticated(req))return send(401,{error:'Sign in required'});
    if(req.method==='GET')return send(200,await live.status());
    if(!requirePost())return;
    if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
    const action=JSON.parse(await body(req,1024));
    if(!action||!['open','close','claim','pause','resume'].includes(action.kind)||Object.keys(action).some(k=>!['kind','market'].includes(k)))return send(400,{error:'Invalid trading action'});
    try{return send(200,await live.execute(action,req.headers['idempotency-key']||''));}catch(e){return send(422,{error:live.safeError(e)});}
   }
   if(url.pathname==='/api/strategy'){
    if(!authenticated(req))return send(401,{error:'Sign in required'});
    if(!requirePost())return;
    if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
    if(setupBusy||live.journal.active()||live.hasUnsettledCycle())return send(409,{error:'Finish the current cycle and buyback before changing strategy.'});
    const input=JSON.parse(await body(req,2048));
    const allowed=['leverage','allocation','minRewardUsd','takeProfit','stopLoss','maxPositionUsd','slippageBps','buybackPercent'];
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k))||allowed.some(k=>!(k in input))||!input.allocation||Object.keys(input.allocation).some(k=>!['BTC','ETH','SOL'].includes(k)))return send(400,{error:'Invalid strategy fields.'});
    if(setupBusy||live.journal.active()||live.hasUnsettledCycle())return send(409,{error:'Finish the current cycle before changing strategy.'});
    setupBusy=true;live.journal.pause(true);
    try{
     const next={...await config(),...input};
     try{validateConfig(next);}catch(e){return send(422,{error:e.message});}
     live.journal.pause(true);
     const result=await command(owner,{type:'configure',config:next},'strategy-'+randomBytes(16).toString('hex'),db);
     if(result.error)return send(422,{error:result.error});
     return send(200,{ok:true,config:next});
    }finally{setupBusy=false;}
   }
   if(url.pathname==='/api/setup'){
    if(!authenticated(req))return send(401,{error:'Sign in required'});
    if(!requirePost())return;
    if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
    if(setupBusy||live.journal.active()||live.hasUnsettledCycle())return send(409,{error:'Wait for the current cycle, buyback or settings save to finish.'});
    const input=JSON.parse(await body(req,4096));
    if(!input||Object.keys(input).some(k=>!['tokenMint','privateKey','cycleSeconds'].includes(k))||typeof input.tokenMint!=='string'||!isPublicKey(input.tokenMint)||!Number.isInteger(input.cycleSeconds)||input.cycleSeconds<10||input.cycleSeconds>86400||input.privateKey!==undefined&&(typeof input.privateKey!=='string'||input.privateKey.length>512))return send(400,{error:'Enter a valid token CA, a cycle interval of 10–86400 seconds, and a valid developer key.'});
    if(input.privateKey&&!(expectedOrigin.startsWith('https:')||env.RAILWAY_ENVIRONMENT_ID||['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&req.headers.host?.startsWith('127.0.0.1:')))return send(400,{error:'Private keys can only be saved over HTTPS or a local loopback connection.'});
    if(setupBusy||live.journal.active()||live.hasUnsettledCycle())return send(409,{error:'Finish the current cycle before changing setup.'});
    setupBusy=true;live.journal.pause(true);
    try{
     const saved=await config();let wallet=developerWalletStatus(input.privateKey||env.DEV_WALLET_PRIVATE_KEY);
     if(wallet.status!=='configured')return send(400,{error:wallet.message});
     if(input.privateKey){try{secrets.save(input.privateKey);env.DEV_WALLET_PRIVATE_KEY=input.privateKey;walletStorageError='';}catch{return send(503,{error:'Wallet could not be stored securely. Check DATA_DIR, the volume, and WALLET_ENCRYPTION_KEY.'});}finally{delete input.privateKey;}}
     const next={...saved,tokenMint:input.tokenMint,vault:wallet.publicKey,creator:wallet.publicKey,treasury:wallet.publicKey,cooldownSeconds:input.cycleSeconds,dataSource:'mainnet'};
     const result=await command(owner,{type:'configure',config:next},'setup-'+randomBytes(16).toString('hex'),db);
     if(result.error)return send(422,{error:result.error});
     live.resetCycle();return send(200,{ok:true,config:next,developerWallet:wallet});
    }finally{setupBusy=false;}
   }
   if(url.pathname==='/api/keeper'){
    if(req.method!=='POST')return send(405,{error:'Method not allowed'});
    if(!env.KEEPER_SECRET||env.KEEPER_SECRET.length<32)return send(503,{error:'Keeper not configured'});
    if(!equal(req.headers.authorization||'','Bearer '+env.KEEPER_SECRET))return send(401,{error:'Unauthorized'});
    if(env.TRADING_MODE&&env.TRADING_MODE!=='mock')return send(503,{error:'Live execution is not enabled'});
    const result=await command(owner,{type:'tick'},req.headers['idempotency-key']||'',db);return send(result.error?422:200,{ok:!result.error,error:result.error,cycle:result.state.cycle,lastTick:result.state.lastTick});
   }
   if(url.pathname==='/api/connections'){
    const saved=await config();
    if(!authenticated(req)&&(req.method!=='GET'||saved.dataSource!=='mainnet'))return send(401,{error:'Sign in required'});
    if(req.method==='GET')return send(200,await connectionReport(saved,env));
    if(!requirePost())return;
    if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
    if(previewInFlight)return send(409,{error:'A preview is already running'});
    const input=JSON.parse(await body(req,1024));if(!['claim','open'].includes(input.kind)||input.kind==='open'&&!['BTC','ETH','SOL'].includes(input.market))return send(400,{error:'Invalid preview request'});
    previewInFlight=true;try{return send(200,await previewMainnet(saved,env,input.kind,input.market));}catch{return send(422,{error:'Preview failed. Check connections, saved addresses, wallet funding and protocol limits.'});}finally{previewInFlight=false;}
   }
   if(url.pathname==='/api/vault'){
    if(!authenticated(req))return send(401,{error:'Sign in required'});
    const decorate=state=>({...publicState(state,!!env.KEEPER_SECRET),owner,authProvider:'password',storagePersistent:!!env.DATA_DIR,developerWallet:developerWalletStatus(env.DEV_WALLET_PRIVATE_KEY,state.config.vault,state.config.creator),walletStorageError});
    if(req.method==='GET')return send(200,decorate(JSON.parse((await readVault(owner,db)).state)));
    if(!requirePost())return;
    if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
    const action=JSON.parse(await body(req));if(!['tick','claim','buyback','close','pause','resume','configure'].includes(action.type)||action.market&&!['BTC','ETH','SOL'].includes(action.market))return send(400,{error:'Invalid action'});
    if(action.type==='configure'&&(live.journal.active()||live.hasUnsettledCycle()))return send(409,{error:'Finish the current cycle and buyback before changing settings.'});
    const result=await command(owner,action,req.headers['idempotency-key']||'',db);return send(result.error?422:200,{...decorate(result.state),error:result.error});
   }
   if(url.pathname.startsWith('/api/'))return send(404,{error:'Not found'});
   if(req.method!=='GET'&&req.method!=='HEAD')return send(405,{error:'Method not allowed'});
   if(url.pathname==='/admin'&&!authenticated(req))return redirect('/admin/login');
   const file=resolve(root,'.'+(url.pathname==='/'||url.pathname==='/admin'?'/portable/index.html':decodeURIComponent(url.pathname)));
   const rel=relative(root,file);if(rel.startsWith('..')||isAbsolute(rel))return send(403,{error:'Invalid path'});
   let stats;try{stats=statSync(file);}catch{return send(404,{error:'Not found'});}if(!stats.isFile())return send(404,{error:'Not found'});
   const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
   res.writeHead(200,{...securityHeaders,'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':url.pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
  }catch(e){if(e instanceof SyntaxError)return send(400,{error:'Invalid request'});if(e.status===413)return send(413,{error:'Request too large'});console.error('Request failed:',e.name);send(503,{error:'Request could not be completed. Retry with the same command key.'});}
 });
 server.requestTimeout=20000;server.headersTimeout=15000;
 return {server,close:()=>new Promise((resolve,reject)=>{live.close();server.close(error=>{sqlite.close();error?reject(error):resolve();});})};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const port=Number(process.env.PORT||3000);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT');
 const app=await createApp();app.server.listen(port,'0.0.0.0',()=>console.log('LONG Vault listening on 0.0.0.0:'+port));
 process.once('SIGTERM',()=>{void app.close().then(()=>process.exit(0));});
 process.once('SIGINT',()=>{void app.close().then(()=>process.exit(0));});
}
