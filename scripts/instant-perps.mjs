import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createPublicKey,verify} from 'node:crypto';
import {PublicKey,TransactionMessage,ComputeBudgetProgram} from '@solana/web3.js';
import {PERPS,POOL,TOKEN,ATA,USDC,SOL,CUSTODY,associated,pda,positionAddress} from './perps-policy.mjs';
const {BorshCoder}=createRequire(import.meta.url)('@coral-xyz/anchor');
const idl=JSON.parse(readFileSync(new URL('../vendor/perps-idl.json',import.meta.url))),coder=new BorshCoder(idl);
const API_KEEPER='perpSnt3NivMdD5DRFc7VmW6x7PuvQJGNyDTL74mEYx';
const MINTS={SOL:SOL.toBase58(),BTC:'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',ETH:'7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'};
const check=(ok,message)=>{if(!ok)throw Error('Transaction rejected: '+message);};
const big=n=>BigInt(n.toString());
export async function inspectInstantTransaction(tx,tables,e,connection){
 const owner=new PublicKey(e.owner),message=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables});
 check(tx.message.header.numRequiredSignatures===3&&tx.message.staticAccountKeys[0].equals(owner),'instant fee payer or signer count mismatch');
 const signers=tx.message.staticAccountKeys.slice(0,3).map(k=>k.toBase58()),apiIndex=signers.indexOf(API_KEEPER),keeper=signers.find(k=>k!==e.owner&&k!==API_KEEPER);
 check(apiIndex>0&&keeper&&tx.signatures[0].every(b=>!b),'unexpected instant signer');
 check(!tx.message.isAccountWritable(1)&&!tx.message.isAccountWritable(2),'keeper must be read-only');
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(API_KEEPER).toBuffer()]),format:'der',type:'spki'});
 check(verify(null,tx.message.serialize(),key,tx.signatures[apiIndex]),'invalid Jupiter API keeper signature');
 check(tx.signatures[signers.indexOf(keeper)].every(b=>!b),'unexpected existing keeper signature');
 const inputMint=e.inputToken==='SOL'?SOL:USDC,collateralMint=new PublicKey(MINTS[e.market]),funding=associated(owner,collateralMint).toBase58(),input=associated(owner,inputMint).toBase58();
 const decoded=message.instructions.filter(ix=>ix.programId.equals(PERPS)).map(ix=>{
  const decoded=coder.instruction.decode(ix.data);check(decoded,'unknown instant instruction');check(coder.instruction.encode(decoded.name,decoded.data).equals(ix.data),'unexpected instruction extension');
  const def=idl.instructions.find(i=>i.name===decoded.name);check(def.accounts.length===ix.keys.length,'unknown instant account layout');
  return {ix,name:decoded.name,p:decoded.data.params,a:Object.fromEntries(def.accounts.map((a,i)=>[a.name,ix.keys[i].pubkey.toBase58()]))};
 });
 const allowed=e.kind==='open'?['setTokenLedger','instantIncreasePositionPreSwap','instantIncreasePosition','instantCreateTpsl']:['instantDecreasePosition','instantDecreasePosition2'];
 check(decoded.every(x=>allowed.includes(x.name)),'unsupported instant instruction');
 const custodyKeys=[...new Set(decoded.flatMap(x=>Object.entries(x.a).filter(([n])=>/^(custody|collateralCustody|receivingCustody|dispensingCustody)$/.test(n)).map(([,v])=>v)))];
 const custodyInfos=await connection.getMultipleAccountsInfo(custodyKeys.map(k=>new PublicKey(k)));
 const custodies=new Map(custodyKeys.map((k,i)=>{const info=custodyInfos[i];check(info?.owner.equals(PERPS),'invalid custody owner');return [k,coder.accounts.decode('Custody',info.data)];}));
 const base={owner:e.owner,keeper,apiKeeper:API_KEEPER,perpetuals:pda([Buffer.from('perpetuals')]).toBase58(),pool:POOL.toBase58(),position:positionAddress(owner,e.market).toBase58(),tokenProgram:TOKEN.toBase58(),associatedTokenProgram:ATA.toBase58(),systemProgram:PublicKey.default.toBase58(),eventAuthority:pda([Buffer.from('__event_authority')]).toBase58(),program:PERPS.toBase58(),referral:PERPS.toBase58(),transferAuthority:pda([Buffer.from('transfer_authority')]).toBase58(),instruction:'Sysvar1nstructions1111111111111111111111111'};
 let opens=0,closes=0,swaps=0,ledgers=0,tp=0,sl=0,ledger;const requests=[];const atas=new Map([[input,inputMint.toBase58()],[funding,collateralMint.toBase58()],[associated(owner).toBase58(),USDC.toBase58()]]);
 for(const x of decoded){const {a,p,name}=x;
  for(const [n,v]of Object.entries(base))if(n in a)check(a[n]===v,'instant '+n+' mismatch');
  for(const prefix of ['custody','collateralCustody','receivingCustody','dispensingCustody'])if(a[prefix]){
   const c=custodies.get(a[prefix]);check(c.pool.toBase58()===POOL.toBase58(),'custody pool mismatch');
   if(a[prefix+'TokenAccount'])check(a[prefix+'TokenAccount']===c.tokenAccount.toBase58(),'custody token destination mismatch');
   for(const suffix of ['DovesPriceAccount','PythnetPriceAccount'])if(a[prefix+suffix])check([c.dovesOracle?.toBase58(),c.dovesAgOracle?.toBase58(),c.oracle?.oracleAccount?.toBase58()].includes(a[prefix+suffix]),'custody oracle mismatch');
  }
  if(p?.requestTime)check(Math.abs(Number(p.requestTime.toString())-Date.now()/1000)<180,'instant quote is stale');
  if(name==='setTokenLedger'){check(++ledgers===1&&a.tokenAccount===funding,'unexpected token ledger');ledger=a.tokenLedger;const info=await connection.getAccountInfo(new PublicKey(ledger));check(info?.owner.equals(PERPS),'invalid token ledger owner');continue;}
  if(name==='instantIncreasePositionPreSwap'){
   check(++swaps===1&&a.owner===e.owner&&a.fundingAccount===input&&a.receivingAccount===funding,'unexpected pre-swap destination');
   check(custodies.get(a.receivingCustody).mint.equals(inputMint)&&a.dispensingCustody===CUSTODY[e.market],'pre-swap custody mismatch');
   check(big(p.amountIn)===BigInt(e.collateral),'pre-swap input amount mismatch');check(big(p.minAmountOut)>=BigInt(e.minOut),'Jupiter collateral-conversion minimum output is below your configured slippage limit. The trade was not signed; use matching collateral or explicitly adjust collateral-swap slippage in Strategy.');continue;
  }
  check(a.custody===CUSTODY[e.market]&&a.collateralCustody===CUSTODY[e.market],'position custody mismatch');
  if(name==='instantIncreasePosition'){
   check(++opens===1&&a.fundingAccount===funding&&big(p.sizeUsdDelta)===BigInt(e.size)&&'Long'in p.side,'instant position amount or side mismatch');
   check(big(p.priceSlippage)>=BigInt(e.mark)&&big(p.priceSlippage)<=BigInt(e.maxPrice),'instant opening slippage exceeds limit');
   if(inputMint.equals(collateralMint))check(p.collateralTokenDelta!==null&&big(p.collateralTokenDelta)===BigInt(e.collateral)&&a.tokenLedger===PERPS.toBase58(),'instant direct collateral mismatch');
   else check(p.collateralTokenDelta===null&&ledger&&a.tokenLedger===ledger&&swaps===1,'instant pre-swap ledger mismatch');
  }else if(name==='instantCreateTpsl'){
   check(a.receivingAccount===associated(owner).toBase58()&&a.desiredMint===USDC.toBase58(),'TP/SL destination mismatch');
   check(big(p.collateralUsdDelta)===0n&&(p.entirePosition||big(p.sizeUsdDelta)===BigInt(e.size)),'TP/SL does not protect the full authorized position');
   check(big(p.triggerPrice)===BigInt(p.triggerAboveThreshold?e.tp:e.sl),'incorrect instant TP/SL price');if(p.triggerAboveThreshold)tp++;else sl++;
   const counter=Buffer.alloc(8);counter.writeBigUInt64LE(big(p.counter));const request=pda([Buffer.from('position_request'),new PublicKey(e.position).toBuffer(),counter,Buffer.from([2])]);
   check(a.positionRequest===request.toBase58()&&a.positionRequestAta===associated(request).toBase58(),'TP/SL request mismatch');requests.push({address:request.toBase58(),trigger:true});
  }else{
   check(++closes===1&&p.entirePosition===true&&big(p.collateralUsdDelta)===0n&&(big(p.sizeUsdDelta)===0n||big(p.sizeUsdDelta)===BigInt(e.size)),'instant close is not full position');
   check(a.receivingAccount===associated(owner).toBase58()&&a.desiredMint===USDC.toBase58(),'instant close destination mismatch');check(big(p.priceSlippage)>=BigInt(e.minPrice)&&big(p.priceSlippage)<=BigInt(e.mark),'instant closing slippage exceeds limit');
   if(name==='instantDecreasePosition2'){const counter=Buffer.alloc(8);counter.writeBigUInt64LE(big(p.counter));const request=pda([Buffer.from('position_request'),new PublicKey(e.position).toBuffer(),counter,Buffer.from([2])]);check(a.positionRequest===request.toBase58()&&a.positionRequestAta===associated(request).toBase58(),'close request mismatch');requests.push({address:request.toBase58(),trigger:false});}
  }
 }
 check(e.kind==='open'?opens===1&&tp===1&&sl===1&&closes===0:closes===1&&opens===0&&tp===0&&sl===0,'missing instant open/close/protection');
 check(new Set(requests.map(r=>r.address)).size===requests.length,'duplicate instant request');
 let wrapped=0n,sync=0,unwrap=0,units=0,price=0n;const compute=new Set();
 for(const ix of message.instructions){if(ix.programId.equals(PERPS))continue;
  if(ix.programId.equals(ComputeBudgetProgram.programId)){const tag=ix.data[0];check(!compute.has(tag)&&!ix.keys.length,'duplicate compute setting');compute.add(tag);if(tag===2&&ix.data.length===5){units=ix.data.readUInt32LE(1);check(units>0&&units<=1400000,'compute limit');}else if(tag===3&&ix.data.length===9)price=ix.data.readBigUInt64LE(1);else check(false,'unsupported compute setting');continue;}
  const k=ix.keys.map(k=>k.pubkey.toBase58());
  if(ix.programId.equals(ATA)){check(k.length===6&&(ix.data.length===0||ix.data.length===1&&ix.data[0]===1)&&k[0]===e.owner&&k[2]===e.owner&&atas.get(k[1])===k[3]&&k[4]===PublicKey.default.toBase58()&&k[5]===TOKEN.toBase58(),'unexpected ATA creation');continue;}
  if(e.kind==='open'&&e.inputToken==='SOL'&&ix.programId.equals(PublicKey.default)){check(ix.data.length===12&&ix.data.readUInt32LE(0)===2&&k.length===2&&k[0]===e.owner&&k[1]===input,'unexpected SOL transfer');wrapped+=ix.data.readBigUInt64LE(4);check(wrapped===BigInt(e.collateral),'SOL wrap exceeds authorized amount');continue;}
  if(e.kind==='open'&&e.inputToken==='SOL'&&ix.programId.equals(TOKEN)){check(ix.data.length===1,'unsupported token instruction');if(ix.data[0]===17){check(++sync===1&&k.length===1&&k[0]===input,'unexpected native sync');}else check(ix.data[0]===9&&++unwrap===1&&k.length===3&&k[0]===input&&k[1]===e.owner&&k[2]===e.owner,'unexpected token close');continue;}
  check(false,'unapproved program or transfer');
 }
 check(price*BigInt(units||1400000)/1000000n<=2000000n,'priority fee exceeds limit');
 if(e.inputToken==='SOL'&&e.kind==='open')check(wrapped===BigInt(e.collateral)&&sync===1,'missing SOL funding');
 return {requests,instant:true,position:e.position};
}
