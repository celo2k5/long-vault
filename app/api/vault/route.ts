import { getChatGPTUser } from '../../chatgpt-auth';
import { readVault,command,publicState } from '@/lib/store';
import { env } from 'cloudflare:workers';
import type { Action } from '@/lib/engine';
export const dynamic='force-dynamic';
const db=()=> (env as unknown as {DB:D1Database}).DB;
const keeper=()=>Boolean((env as unknown as {KEEPER_SECRET?:string}).KEEPER_SECRET);
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function mode(){if((env as unknown as {TRADING_MODE?:string}).TRADING_MODE && (env as unknown as {TRADING_MODE?:string}).TRADING_MODE!=='mock')throw Error('Live execution is not implemented. Set TRADING_MODE=mock.');}
export async function GET(){const user=await getChatGPTUser();if(!user)return reply({error:'Sign in to open your vault.'},401);try{mode();const row=await readVault(user.userId,db());return reply({...publicState(JSON.parse(row.state),keeper()),owner:user.userId});}catch{return reply({error:'Vault unavailable. Check storage and server mode configuration.'},503);}}
export async function POST(request:Request){const user=await getChatGPTUser();if(!user)return reply({error:'Sign in required.'},401);
 const origin=request.headers.get('origin');if(origin!==new URL(request.url).origin)return reply({error:'Same-origin requests only.'},403);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'JSON required.'},415);
 try{mode();const raw=await request.text();if(raw.length>8192)return reply({error:'Request too large.'},413);const action=JSON.parse(raw) as Action;
 if(!['tick','claim','buyback','close','pause','resume','configure'].includes(action.type))return reply({error:'Unknown action.'},400);
 if(action.market&&!['BTC','ETH','SOL'].includes(action.market))return reply({error:'Unknown market.'},400);
 const key=request.headers.get('idempotency-key')||'';const result=await command(user.userId,action,key,db());return reply({...publicState(result.state,keeper()),owner:user.userId,error:result.error},result.error?422:200);
 }catch(e){console.error('Vault command failed',e instanceof Error?e.name:'Error');return reply({error:'Command could not be committed. Retry using the same command key.'},503);}}


