// LOOPBACK-ONLY MOCK DEVELOPMENT SERVER. Never expose this server publicly.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readVault,command,publicState} from '../.sites-runtime/lib/store.mjs';
import {connectionReport} from '../.sites-runtime/lib/connections.mjs';
import {previewMainnet} from '../.sites-runtime/lib/mainnet.mjs';
mkdirSync('.sites-runtime',{recursive:true});
const sqlite=new DatabaseSync('.sites-runtime/local-vault.sqlite');
sqlite.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
const journal=JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8'));
for(const migration of journal.entries){if(!sqlite.prepare('SELECT 1 FROM local_migrations WHERE name=?').get(migration.tag)){sqlite.exec('BEGIN');try{sqlite.exec(readFileSync('drizzle/'+migration.tag+'.sql','utf8'));sqlite.prepare('INSERT INTO local_migrations VALUES (?)').run(migration.tag);sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}}}
function prepare(query){let args=[];return {bind(...values){args=values;return this;},async first(){return sqlite.prepare(query).get(...args)||null;},async all(){return {results:sqlite.prepare(query).all(...args)};},async run(){return this.sync();},sync(){const r=sqlite.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}};}}}
const db={prepare,async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const rows=statements.map(s=>s.sync());sqlite.exec('COMMIT');return rows;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const sessions=new Set();const host='http://127.0.0.1:5173';const root=resolve('.sites-runtime/preview');
createServer(async(req,res)=>{const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
try{
 if(req.headers.host!=='127.0.0.1:5173')return send(403,{error:'Loopback host required'});
 const url=new URL(req.url,host);
 if(url.pathname==='/signin-with-chatgpt'){const token=randomUUID();sessions.add(token);res.writeHead(302,{'Location':url.searchParams.get('return_to')==='/admin'?'/admin':'/','Set-Cookie':'tek_local='+token+'; HttpOnly; SameSite=Strict; Path=/'});return res.end();}
 if(url.pathname==='/api/public'&&req.method==='GET'){const row=await readVault('local_mock_admin',db);return send(200,{...publicState(JSON.parse(row.state)),events:[],owner:''});}
 if(url.pathname==='/api/connections'){
 const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('tek_local='))?.slice(10);
 const config=JSON.parse((await readVault('local_mock_admin',db)).state).config;
 if(!sessions.has(cookie)&&(req.method!=='GET'||config.dataSource!=='mainnet'))return send(401,{error:'Sign in to check connections'});
 if(req.method==='GET')return send(200,await connectionReport(config,process.env));
 if(req.method!=='POST')return send(405,{error:'Method not allowed'});
 if(req.headers.origin!==host)return send(403,{error:'Same-origin requests only'});
 if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
 let body='';for await(const chunk of req){body+=chunk;if(body.length>1024)return send(413,{error:'Request too large'});}
 const request=JSON.parse(body);if(!['claim','open'].includes(request.kind)||request.kind==='open'&&!['BTC','ETH','SOL'].includes(request.market))return send(400,{error:'Invalid preview'});
 try{return send(200,await previewMainnet(config,process.env,request.kind,request.market));}catch{return send(422,{error:'Preview failed. Check connections, saved addresses, wallet funding and protocol limits.'});}
 }
 if(url.pathname==='/api/vault'){
 const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('tek_local='))?.slice(10);
 if(!sessions.has(cookie))return send(401,{error:'Sign in to your local simulated vault.'});
 if(req.method==='GET'){const row=await readVault('local_mock_admin',db);return send(200,{...publicState(JSON.parse(row.state)),owner:'local_mock_admin'});}
 if(req.method!=='POST')return send(405,{error:'Method not allowed'});
 if(req.headers.origin!==host)return send(403,{error:'Same-origin requests only'});
 if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
 let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)return send(413,{error:'Request too large'});}
 const a=JSON.parse(body);if(!['tick','claim','buyback','close','pause','resume','configure'].includes(a.type)||a.market&&!['BTC','ETH','SOL'].includes(a.market))return send(400,{error:'Invalid action'});
 const r=await command('local_mock_admin',a,req.headers['idempotency-key']||'',db);return send(r.error?422:200,{...publicState(r.state),owner:'local_mock_admin',error:r.error});
 }
 const file=resolve(root,'.'+((url.pathname==='/'||url.pathname==='/admin')?'/portable/index.html':decodeURIComponent(url.pathname)));
 if(!file.startsWith(root+'/')&&!file.startsWith(root+'\\'))return send(403,{error:'Invalid path'});
 if(!existsSync(file))return send(404,{error:'Not found'});
 const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
 res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(readFileSync(file));
}catch(e){console.error(e.message);send(500,{error:'Local mock request failed.'});}
}).listen(5173,'127.0.0.1',()=>console.log('LONG local simulation: '+host));

