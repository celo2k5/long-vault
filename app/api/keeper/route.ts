import {env} from 'cloudflare:workers';
import {command} from '@/lib/store';
export const dynamic='force-dynamic';
async function equal(a:string,b:string){const digest=async(s:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));const [x,y]=await Promise.all([digest(a),digest(b)]);let mismatch=0;for(let i=0;i<x.length;i++)mismatch|=x[i]^y[i];return mismatch===0;}
export async function POST(request:Request){const vars=env as unknown as {KEEPER_SECRET?:string;VAULT_OWNER_ID?:string;TRADING_MODE?:string};
 if(!vars.KEEPER_SECRET||vars.KEEPER_SECRET.length<32||!vars.VAULT_OWNER_ID)return Response.json({error:'Keeper is not configured.'},{status:503});
 if(!await equal(request.headers.get('authorization')||'','Bearer '+vars.KEEPER_SECRET))return Response.json({error:'Unauthorized.'},{status:401});
 if(vars.TRADING_MODE&&vars.TRADING_MODE!=='mock')return Response.json({error:'Live execution is disabled.'},{status:503});
 try{const result=await command(vars.VAULT_OWNER_ID,{type:'tick'},request.headers.get('idempotency-key')||'',(env as unknown as {DB:D1Database}).DB);return Response.json({ok:!result.error,error:result.error,cycle:result.state.cycle,lastTick:result.state.lastTick},{status:result.error?422:200});}catch{return Response.json({error:'Keeper commit failed. Retry the same idempotency key.'},{status:503});}}


