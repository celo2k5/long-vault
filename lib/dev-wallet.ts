// Server-only: secret material must never be serialized, persisted, or logged.
import {Keypair} from '@solana/web3.js';
export type WalletStatus={status:'missing'|'invalid'|'configured'|'mismatch';publicKey:string|null;message:string};
export function loadDeveloperWallet(secret:string|undefined):Keypair{
 if(!secret?.trim())throw Error('Developer wallet secret is missing');
 let bytes:Uint8Array|undefined;
 try{
  const text=secret.trim();if(text.length>512)throw Error();
  if(text.startsWith('[')){
   const values:unknown=JSON.parse(text);
   if(!Array.isArray(values)||values.length!==64||values.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error();
   bytes=Uint8Array.from(values);
  }else{
   const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
   let value=BigInt(0);for(const c of text){const digit=alphabet.indexOf(c);if(digit<0)throw Error();value=value*BigInt(58)+BigInt(digit);}
   const decoded:number[]=[];while(value){decoded.unshift(Number(value&BigInt(255)));value>>=BigInt(8);}
   for(const c of text){if(c!=='1')break;decoded.unshift(0);}
   if(decoded.length!==64)throw Error();bytes=Uint8Array.from(decoded);
  }
  return Keypair.fromSecretKey(bytes);
 }catch{throw Error('Invalid developer wallet key. Use base58 or a JSON array of 64 bytes.');}
 finally{bytes?.fill(0);}
}
export function developerWalletStatus(secret:string|undefined,vault?:string,creator?:string):WalletStatus{
 if(!secret?.trim())return {status:'missing',publicKey:null,message:'Set DEV_WALLET_PRIVATE_KEY in Railway Variables, then deploy.'};
 try{const wallet=loadDeveloperWallet(secret),publicKey=wallet.publicKey.toBase58();
  if((vault&&vault!==publicKey)||(creator&&creator!==publicKey))return {status:'mismatch',publicKey,message:'The developer wallet must match both the vault and creator authority.'};
  return {status:'configured',publicKey,message:'Key validated. See Live positions for execution status.'};
 }catch{return {status:'invalid',publicKey:null,message:'Invalid key. Use a Solana 64-byte secret key as base58 or a JSON byte array. Seed phrases are not accepted.'};}
}
