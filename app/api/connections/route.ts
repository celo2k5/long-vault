import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readVault} from '@/lib/store';
import {connectionReport} from '@/lib/connections';
import {previewMainnet,type LiveEnvironment} from '@/lib/mainnet';
import {MARKETS,type Config,type Market} from '@/lib/engine';
export const dynamic='force-dynamic';
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const vars=()=>env as unknown as LiveEnvironment&{DB:D1Database;VAULT_OWNER_ID?:string};
export async function GET(){
 const e=vars(),user=await getChatGPTUser();
 const owner=e.VAULT_OWNER_ID||user?.userId;
 if(!owner)return reply({error:'Sign in or configure the public vault owner'},401);
 const config=(JSON.parse((await readVault(owner,e.DB)).state) as {config:Config}).config;
 if(!user&&config.dataSource!=='mainnet')return reply({error:'Mainnet monitoring is not selected'},403);
 try{return reply(await connectionReport(config,e));}catch{return reply({error:'Connection checks unavailable. Review saved settings.'},503);}
}
export async function POST(request:Request){
 const e=vars(),user=await getChatGPTUser();if(!user)return reply({error:'Sign in required'},401);
 if(e.VAULT_OWNER_ID&&user.userId!==e.VAULT_OWNER_ID)return reply({error:'Only the configured vault administrator can request previews'},403);
 if(request.headers.get('origin')!==new URL(request.url).origin)return reply({error:'Same-origin requests only'},403);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'JSON required'},415);
 try{const raw=await request.text();if(raw.length>1024)return reply({error:'Request too large'},413);const body=JSON.parse(raw) as {kind:string;market:Market};if(!['claim','open'].includes(body.kind)||body.kind==='open'&&!MARKETS.includes(body.market))return reply({error:'Invalid preview request'},400);
 const config=(JSON.parse((await readVault(user.userId,e.DB)).state) as {config:Config}).config;
 return reply(await previewMainnet(config,e,body.kind as 'claim'|'open',body.market));
 }catch{return reply({error:'Preview failed. Check connections, saved addresses, wallet funding and protocol limits.'},422);}
}
