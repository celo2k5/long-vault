import { initialState,transition,type State,type Action,type Event } from './engine.ts';
type Row={owner:string;version:number;state:string};
function cleanState(previous?:State){const state=initialState();return {...state,config:{...(previous?.config||state.config),dataSource:'mainnet' as const},pending:0,paused:true,lastTick:0,nextCycleAt:0,schemaVersion:2};}
export async function readVault(owner:string,d:D1Database):Promise<Row>{
 if(!d)throw Error('Vault storage unavailable.');
 for(let attempt=0;attempt<5;attempt++){
  let row=await d.prepare('SELECT owner, version, state FROM vaults WHERE owner = ?').bind(owner).first<Row>();
  if(!row){await d.prepare('INSERT OR IGNORE INTO vaults (owner,version,state) VALUES (?,0,?)').bind(owner,JSON.stringify(cleanState())).run();continue;}
  const state=JSON.parse(row.state) as State & {schemaVersion?:number};
  if(state.schemaVersion===2)return row;
  // One-time retirement of synthetic balances/history, preserving user addresses and settings.
  const fence=crypto.randomUUID();const next=cleanState(state);
  const guard='EXISTS (SELECT 1 FROM vaults WHERE owner = ? AND version = ? AND last_command = ?)';
  const results=await d.batch([
   d.prepare('UPDATE vaults SET state = ?, version = version + 1, last_command = ? WHERE owner = ? AND version = ?').bind(JSON.stringify(next),fence,owner,row.version),
   d.prepare('DELETE FROM activity WHERE owner = ? AND '+guard).bind(owner,owner,row.version+1,fence),
   d.prepare('DELETE FROM commands WHERE owner = ? AND '+guard).bind(owner,owner,row.version+1,fence)
  ]);
  if(results[0].meta.changes===1)return {owner,version:row.version+1,state:JSON.stringify(next)};
 }
 throw Error('Vault busy while retiring simulation data. Retry.');
}
export async function command(owner:string,action:Action,id:string,d:D1Database){
 if(!/^[a-zA-Z0-9:_-]{8,120}$/.test(id))throw Error('Invalid idempotency key.');
 if(action.type==='configure'&&action.config)action={...action,config:{...action.config,dataSource:'mainnet'}};
 const fingerprint=JSON.stringify(action);
 for(let attempt=0;attempt<5;attempt++){
 const receipt=await d.prepare('SELECT fingerprint,error FROM commands WHERE owner = ? AND key = ?').bind(owner,id).first<{fingerprint:string;error:string|null}>();
 const row=await readVault(owner,d);
 if(receipt){if(receipt.fingerprint!==fingerprint)throw Error('Idempotency key already used for a different command.');return {state:JSON.parse(row.state) as State,error:receipt.error||undefined,duplicate:true};}
 const before=JSON.parse(row.state) as State;before.processed={};
 const result=transition(before,action,id);const oldIds=new Set(before.events.map(e=>e.id));const newEvents=result.state.events.filter(e=>!oldIds.has(e.id));
 result.state.processed={};result.state.events=result.state.events.slice(0,200);
 const fence=crypto.randomUUID();
 const statements=[
 d.prepare('UPDATE vaults SET state = ?, version = version + 1, last_command = ? WHERE owner = ? AND version = ?').bind(JSON.stringify(result.state),fence,owner,row.version),
 d.prepare('INSERT OR IGNORE INTO commands (owner,key,fingerprint,error) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM vaults WHERE owner = ? AND version = ? AND last_command = ?)').bind(owner,id,fingerprint,result.error||null,owner,row.version+1,fence),
 ...newEvents.map(e=>d.prepare('INSERT OR IGNORE INTO activity (owner,id,time,event) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM vaults WHERE owner = ? AND version = ? AND last_command = ?)').bind(owner,e.id,e.time,JSON.stringify(e),owner,row.version+1,fence))
 ];
 const committed=await d.batch(statements);
 if(committed[0].meta.changes===1)return result;
 await new Promise(r=>setTimeout(r,20*(attempt+1)));
 }throw Error('Vault busy. Retry the same command key.');
}
export function publicState(state:State,keeperConfigured=false){return {config:{...state.config,dataSource:'mainnet'},paused:state.paused,mode:'mainnet-monitor',keeperConfigured,events:state.events.filter(e=>e.kind==='Config').map(e=>({...e,signature:null,amount:0})).slice(0,200)};}
export async function history(owner:string,d:D1Database,before:number){const rows=await d.prepare('SELECT event FROM activity WHERE owner = ? AND time < ? ORDER BY time DESC LIMIT 200').bind(owner,before).all<{event:string}>();return rows.results.map(r=>JSON.parse(r.event) as Event);}



