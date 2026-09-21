import {env} from 'cloudflare:workers';
import {readVault,publicState} from '@/lib/store';
export const dynamic='force-dynamic';
export async function GET(){
 const vars=env as unknown as {DB:D1Database;VAULT_OWNER_ID?:string};
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(!vars.VAULT_OWNER_ID)return Response.json({error:'Public vault not configured. Set VAULT_OWNER_ID to the admin account ID shown in Admin.'},{status:503,headers});
 try{const row=await readVault(vars.VAULT_OWNER_ID,vars.DB);const state=publicState(JSON.parse(row.state));return Response.json({...state,events:[],owner:''},{headers});}
 catch{return Response.json({error:'Public vault temporarily unavailable'},{status:503,headers});}
}
