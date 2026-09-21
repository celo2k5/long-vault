import type {Config} from './engine.ts';
import {readMainnet,type LiveEnvironment,type MainnetReport} from './mainnet.ts';
// Single-flight and short cache prevent every dashboard viewer repeating all RPC calls.
// One configured project per deployment. Include config and server connection settings in the key.
let cached:{key:string;expires:number;value:Promise<MainnetReport>}|undefined;
export function connectionReport(config:Config,env:LiveEnvironment){
 const key=JSON.stringify([config,env.SOLANA_RPC_URL,env.JUPITER_API_URL,env.JUPITER_API_KEY]);
 if(cached?.key===key&&cached.expires>Date.now())return cached.value;
 const value=readMainnet(config,env);cached={key,expires:Infinity,value};
 value.then(()=>{if(cached?.value===value)cached.expires=Date.now()+15000;},()=>{if(cached?.value===value)cached=undefined;});return value;
}
