import {PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {PERPS,TOKEN,ATA,USDC,associated,discriminator} from './perps-policy.mjs';
const JUP=new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TOKEN2022=new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const check=(ok,message)=>{if(!ok)throw Object.assign(Error(message),{safe:true});};
export const tokenAta=(owner,mint,program=TOKEN)=>PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),program.toBuffer(),new PublicKey(mint).toBuffer()],ATA)[0];
function decode58(s){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const c of s){const i=alphabet.indexOf(c);check(i>=0,'Invalid transaction encoding.');n=n*58n+BigInt(i);}const a=[];while(n){a.unshift(Number(n%256n));n/=256n;}for(const c of s){if(c!=='1')break;a.unshift(0);}return Buffer.from(a);}
export function transactionKeys(t){const m=t.transaction.message;return [...(m.staticAccountKeys||m.accountKeys),...(t.meta.loadedAddresses?.writable||[]),...(t.meta.loadedAddresses?.readonly||[])].map(k=>k.toBase58());}
export function tokenDelta(t,address,mint,owner){
 check(t?.meta&&!t.meta.err,'Finalized transaction receipt is unavailable.');const i=transactionKeys(t).indexOf(address);
 check(i>=0,'Expected token account is absent from receipt.');
 const amount=list=>{const b=list?.find(b=>b.accountIndex===i);if(!b)return 0n;check(b.mint===mint&&b.owner===owner,'Receipt token authority mismatch.');return BigInt(b.uiTokenAmount.amount);};
 return amount(t.meta.postTokenBalances)-amount(t.meta.preTokenBalances);
}
// Only a transfer signed by THIS recorded Jupiter request PDA counts as close proceeds.
// Wallet deposits, API PnL estimates and a finalized request submission are not receipts.
export function closeReceipt(t,owner,request){
 if(!t?.meta||t.meta.err)return 0n;
 const keys=transactionKeys(t),source=associated(request).toBase58(),destination=associated(owner).toBase58();
 let paid=0n;
 for(const group of t.meta.innerInstructions||[])for(const ix of group.instructions){
  if(keys[ix.programIdIndex]!==TOKEN.toBase58()||typeof ix.data!=='string')continue;
  const d=decode58(ix.data),a=ix.accounts.map(i=>keys[i]);
  if(d.length===9&&d[0]===3&&a[0]===source&&a[1]===destination&&a[2]===request)paid+=d.readBigUInt64LE(1);
  if(d.length===10&&d[0]===12&&a[0]===source&&a[1]===USDC.toBase58()&&a[2]===destination&&a[3]===request&&d[9]===6)paid+=d.readBigUInt64LE(1);
 }
 if(!paid)return 0n;
 check(keys.includes(PERPS.toBase58()),'Close receipt is missing the perpetuals program.');
 const delta=tokenDelta(t,destination,USDC.toBase58(),owner);return delta>0n?(paid<delta?paid:delta):0n;
}
export function buybackBudget(received,principal,feeReserve,percent,spent){
 const profit=BigInt(received)-BigInt(principal)-BigInt(feeReserve);
 const target=profit>0n?profit*BigInt(Math.floor(percent*100))/10000n:0n;
 return target>BigInt(spent)?target-BigInt(spent):0n;
}
let swapQueue=Promise.resolve(),nextSwapAt=0;
export function swapApi(env,path,body){
 const operation=swapQueue.then(async()=>{
  for(let attempt=0;attempt<3;attempt++){
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,nextSwapAt-Date.now())));
   nextSwapAt=Date.now()+(env.JUPITER_API_KEY?1100:2100);
   const r=await fetch('https://api.jup.ag/swap/v1/'+path,{method:body?'POST':'GET',headers:{...(env.JUPITER_API_KEY?{'x-api-key':env.JUPITER_API_KEY}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
   if((r.status===429||r.status>=500)&&attempt<2){
    const seconds=Number(r.headers.get('retry-after'));
    nextSwapAt=Math.max(nextSwapAt,Date.now()+Math.min(30000,Math.max(2100,Number.isFinite(seconds)?seconds*1000:0,2100*2**attempt)));
    await r.body?.cancel();continue;
   }
   check(r.ok,'Jupiter buyback quote unavailable. The profit remains in USDC.');const text=await r.text();check(text.length<1000000,'Buyback response exceeds size limit.');return JSON.parse(text);
  }
 });
 swapQueue=operation.catch(()=>{});return operation;
}
export function inspectSwap(ix,owner,mint,destination,amount,quote,slippage){
 check(ix.programId.equals(JUP),'Unexpected swap program.');
 const d=ix.data,k=ix.keys.map(k=>k.pubkey.toBase58()),shared=d.subarray(0,8).equals(discriminator('global:shared_accounts_route')),route=d.subarray(0,8).equals(discriminator('global:route'));
 check(shared||route,'Unsupported Jupiter swap instruction version.');
 check(d.length>=31,'Truncated swap instruction.');
 const tail=d.subarray(-19);
 check(tail.readBigUInt64LE(0)===BigInt(amount)&&tail.readBigUInt64LE(8)===BigInt(quote.outAmount)&&tail.readUInt16LE(16)===slippage&&tail[18]===0,'Buyback amount, minimum output or fee was changed.');
 const source=associated(owner).toBase58(),j=JUP.toBase58();
 check(k[0]===TOKEN.toBase58(),'Unexpected input token program.');
 if(shared)check(k[2]===owner&&k[3]===source&&k[6]===destination&&k[7]===USDC.toBase58()&&k[8]===mint&&k[9]===j,'Buyback destination or authority mismatch.');
 else check(k[1]===owner&&k[2]===source&&k[3]===destination&&(k[4]===j||k[4]===destination)&&k[5]===mint&&k[6]===j,'Buyback destination or authority mismatch.');
 check(ix.keys.every(k=>!k.isSigner||k.pubkey.toBase58()===owner),'Unexpected swap signer.');
 // A swap cannot use the wallet's SOL balance as an additional funding source.
 check(ix.keys.every(k=>k.pubkey.toBase58()!==owner||!k.isWritable),'Swap requests writable wallet authority.');
}
export async function prepareBuyback(connection,env,c,amount,api=(p,b)=>swapApi(env,p,b)){
 check(amount>0n&&amount<=BigInt(Number.MAX_SAFE_INTEGER),'Invalid realized-profit amount.');
 const owner=c.vault,mint=new PublicKey(c.tokenMint);check(!mint.equals(USDC),'The buyback CA cannot be USDC.');
 const mintInfo=await connection.getAccountInfo(mint,'confirmed');
 check(mintInfo&&(mintInfo.owner.equals(TOKEN)||mintInfo.owner.equals(TOKEN2022))&&mintInfo.data.length>=82&&mintInfo.data[45]===1,'Buyback token mint is unavailable.');
 // Permit metadata-only Token-2022 extensions; reject transfer hooks, taxes and permanent delegates.
 if(mintInfo.data.length!==82){
  check(mintInfo.owner.equals(TOKEN2022)&&mintInfo.data.length>=166&&mintInfo.data[165]===1,'Invalid extended mint.');
  let offset=166;while(offset<mintInfo.data.length){
   if(mintInfo.data.subarray(offset).every(b=>b===0))break;
   check(offset+4<=mintInfo.data.length,'Truncated mint extension.');
   const type=mintInfo.data.readUInt16LE(offset),length=mintInfo.data.readUInt16LE(offset+2);offset+=4;
   check([18,19].includes(type)&&offset+length<=mintInfo.data.length,'Buyback mint has unsupported transfer or authority extensions.');offset+=length;
  }
 }
 const destination=tokenAta(owner,mint,mintInfo.owner),source=associated(owner);
 const [input,output,sol]=await Promise.all([connection.getAccountInfo(source),connection.getAccountInfo(destination),connection.getBalance(new PublicKey(owner))]);
 const validAccount=(a,m,p)=>a&&a.owner.equals(p)&&a.data.length>=165&&new PublicKey(a.data.subarray(0,32)).equals(m)&&new PublicKey(a.data.subarray(32,64)).toBase58()===owner&&a.data[108]===1&&a.data.readUInt32LE(72)===0&&a.data.readUInt32LE(129)===0;
 check(validAccount(input,USDC,TOKEN)&&input.data.readBigUInt64LE(64)>=amount,'Insufficient verified USDC profit balance.');
 check(!output||validAccount(output,mint,mintInfo.owner),'Buyback destination authority is invalid.');
 check(sol>=40000000,'Keep 0.04 SOL for buyback fees and rent.');
 const quote=await api('quote?'+new URLSearchParams({inputMint:USDC.toBase58(),outputMint:mint.toBase58(),amount:String(amount),slippageBps:String(c.slippageBps),swapMode:'ExactIn',instructionVersion:'V1',restrictIntermediateTokens:'true'}));
 check(quote.inputMint===USDC.toBase58()&&quote.outputMint===c.tokenMint&&quote.inAmount===String(amount)&&quote.swapMode==='ExactIn'&&quote.slippageBps===c.slippageBps&&!Number(quote.platformFee?.feeBps),'Jupiter quote does not match the authorized buyback.');
 check(/^\d+$/.test(quote.outAmount)&&/^\d+$/.test(quote.otherAmountThreshold),'Invalid swap output.');
 const minimum=BigInt(quote.outAmount)*BigInt(10000-c.slippageBps)/10000n;
 check(minimum>0n&&BigInt(quote.otherAmountThreshold)>=minimum&&Number.isFinite(Number(quote.priceImpactPct))&&Math.abs(Number(quote.priceImpactPct))<=0.03,'Buyback liquidity or price impact exceeds limits.');
 const raw=await api('swap-instructions',{userPublicKey:owner,quoteResponse:quote,destinationTokenAccount:destination.toBase58(),wrapAndUnwrapSol:false,useSharedAccounts:true,dynamicComputeUnitLimit:false});
 check(!raw.tokenLedgerInstruction&&!raw.cleanupInstruction&&!(raw.otherInstructions?.length),'Unexpected extra swap instructions.');
 // Construct setup and fee instructions locally; never sign API-provided setup instructions.
 const swap=new TransactionInstruction({programId:new PublicKey(raw.swapInstruction.programId),keys:raw.swapInstruction.accounts.map(a=>({pubkey:new PublicKey(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable})),data:Buffer.from(raw.swapInstruction.data,'base64')});
 inspectSwap(swap,owner,c.tokenMint,destination.toBase58(),amount,quote,c.slippageBps);
 const setup=new TransactionInstruction({programId:ATA,keys:[{pubkey:new PublicKey(owner),isSigner:true,isWritable:true},{pubkey:destination,isSigner:false,isWritable:true},{pubkey:new PublicKey(owner),isSigner:false,isWritable:false},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:PublicKey.default,isSigner:false,isWritable:false},{pubkey:mintInfo.owner,isSigner:false,isWritable:false}],data:Buffer.from([1])});
 const tables=await Promise.all((raw.addressLookupTableAddresses||[]).map(async address=>{const r=await connection.getAddressLookupTable(new PublicKey(address));check(r.value,'Missing swap lookup table.');return r.value;}));
 const latest=await connection.getLatestBlockhash();
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(owner),recentBlockhash:latest.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:100000}),setup,swap]}).compileToV0Message(tables));
 check(tx.message.header.numRequiredSignatures===1,'Unexpected buyback signer.');
 // Disallow access to any other wallet-controlled accounts, including existing token delegates.
 const writable=tx.message.getAccountKeys({addressLookupTableAccounts:tables});
 const addresses=[];for(let i=0;i<writable.length;i++)if(tx.message.isAccountWritable(i))addresses.push(writable.get(i));
 check(addresses.length<=100,'Swap touches too many writable accounts.');
 const infos=await connection.getMultipleAccountsInfo(addresses);
 infos.forEach((a,i)=>{const key=addresses[i].toBase58();if(key===owner||key===source.toBase58()||key===destination.toBase58())return;
  if(a&&(a.owner.equals(TOKEN)||a.owner.equals(TOKEN2022))&&a.data.length>=165)check(new PublicKey(a.data.subarray(32,64)).toBase58()!==owner&&!(a.data.readUInt32LE(72)===1&&new PublicKey(a.data.subarray(76,108)).toBase58()===owner),'Swap attempts to access another wallet token account.');
 });
 const fee=await connection.getFeeForMessage(tx.message);check(fee.value!==null&&fee.value<=200000,'Buyback network fee exceeds limit.');
 const simulation=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:false,accounts:{encoding:'base64',addresses:[owner,source.toBase58(),destination.toBase58()]}});
 check(!simulation.value.err&&simulation.value.accounts?.every(Boolean),'Buyback simulation failed. Profit remains in USDC.');
 const [walletAfter,inAfter,outAfter]=simulation.value.accounts,asAccount=a=>({owner:new PublicKey(a.owner),data:Buffer.from(a.data[0],'base64')});
 check(sol-walletAfter.lamports<=10000000&&walletAfter.lamports>=5000000,'Buyback SOL spending exceeds limit.');
 const ia=asAccount(inAfter),oa=asAccount(outAfter);
 check(validAccount(ia,USDC,TOKEN)&&validAccount(oa,mint,mintInfo.owner)&&input.data.readBigUInt64LE(64)-ia.data.readBigUInt64LE(64)===amount&&oa.data.readBigUInt64LE(64)-(output?.data.readBigUInt64LE(64)||0n)>=minimum,'Buyback simulation changed the amount, destination or token authority.');
 return {tx,lastHeight:latest.lastValidBlockHeight,expected:{kind:'buyback',owner,mint:c.tokenMint,source:source.toBase58(),destination:destination.toBase58(),amount:String(amount),minimum:String(minimum),requests:[]}};
}
