// Fail-closed instruction policy. Layout source: Jupiter's documented Anchor IDL.
// https://developers.jup.ag/docs/perps/position-request-account
import {createHash} from 'node:crypto';
import {PublicKey,TransactionMessage,ComputeBudgetProgram} from '@solana/web3.js';
export const PERPS=new PublicKey('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu');
export const POOL=new PublicKey('5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq');
export const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const USDC=new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const SOL=new PublicKey('So11111111111111111111111111111111111111112');
export const CUSTODY={SOL:'7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz',ETH:'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn',BTC:'5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm'};
export const discriminator=name=>createHash('sha256').update(name).digest().subarray(0,8);
export const pda=seeds=>PublicKey.findProgramAddressSync(seeds,PERPS)[0];
export const associated=(owner,mint=USDC)=>PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),TOKEN.toBuffer(),mint.toBuffer()],ATA)[0];
export function positionAddress(owner,market){const custody=new PublicKey(CUSTODY[market]);return pda([Buffer.from('position'),new PublicKey(owner).toBuffer(),POOL.toBuffer(),custody.toBuffer(),custody.toBuffer(),Buffer.from([1])]);}
const invariant=(ok,message)=>{if(!ok)throw Error('Transaction rejected: '+message);};
class Reader{
 constructor(data){this.data=Buffer.from(data);this.offset=8;}
 byte(){invariant(this.offset<this.data.length,'truncated instruction');return this.data[this.offset++];}
 u64(){invariant(this.offset+8<=this.data.length,'truncated amount');const n=this.data.readBigUInt64LE(this.offset);this.offset+=8;return n;}
 bool(){const v=this.byte();invariant(v<2,'invalid boolean');return v===1;}
 option(read){const tag=this.byte();invariant(tag<2,'invalid option');return tag?read.call(this):null;}
 end(){invariant(this.offset===this.data.length,'unknown instruction extension');}
}
export function inspectPerpsTransaction(tx,lookups,expected){
 const owner=new PublicKey(expected.owner),position=positionAddress(owner,expected.market);
 invariant(position.toBase58()===expected.position,'position does not belong to the selected wallet and market');
 // Jupiter's instant API requires keeper co-signatures and different execution/settlement layouts.
 // Recognize the format for diagnostics only; do not weaken the legacy signing policy.
 const instantNames=['instant_increase_position','instant_decrease_position','instant_create_tpsl'];
 const instant=tx.message.compiledInstructions.some(ix=>instantNames.some(name=>Buffer.from(ix.data).subarray(0,8).equals(discriminator('global:'+name))));
 invariant(!instant,'Jupiter returned its instant-trade format with keeper co-signers. This execution adapter does not support that format yet; no wallet signature or transaction was sent. Changing wallet funding will not fix this.');
 invariant(tx.message.header.numRequiredSignatures===1&&tx.message.staticAccountKeys[0].equals(owner),'unexpected signer');
 invariant(tx.signatures.every(s=>s.every(b=>b===0)),'transaction is already signed');
 const message=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:lookups});
 const inputMint=expected.inputToken==='SOL'?SOL:USDC;
 const requests=[],atas=new Map([[associated(owner).toBase58(),owner.toBase58()+':'+USDC.toBase58()],[associated(owner,SOL).toBase58(),owner.toBase58()+':'+SOL.toBase58()]]);
 let wrapped=0n,syncs=0,unwraps=0;
 let increases=0,closes=0,tp=0,sl=0,units=0,unitPrice=0n;
 const computeTags=new Set();
 for(const ix of message.instructions){
  if(!ix.programId.equals(PERPS))continue;
  const name=['create_increase_position_market_request','create_decrease_position_market_request','create_decrease_position_request2'].find(n=>ix.data.subarray(0,8).equals(discriminator('global:'+n)));
  invariant(name,'unapproved perpetual instruction');
  const modern=name==='create_decrease_position_request2',isOpen=name==='create_increase_position_market_request';
  invariant(ix.keys.length===(modern?18:16),'unknown account layout');
  const a=i=>ix.keys[i].pubkey;
  const mint=isOpen?inputMint:USDC;
  invariant(a(0).equals(owner)&&a(1).equals(associated(owner,mint))&&a(2).equals(pda([Buffer.from('perpetuals')]))&&a(3).equals(POOL)&&a(4).equals(position),'wallet, destination or pool mismatch');
  invariant(a(7).toBase58()===CUSTODY[expected.market]&&a(modern?10:8).equals(a(7))&&a(modern?11:9).equals(mint),'incorrect custody or collateral mint');
  const tail=modern?12:10;
  invariant(a(tail).equals(PERPS)&&a(tail+1).equals(TOKEN)&&a(tail+2).equals(ATA)&&a(tail+3).equals(PublicKey.default)&&a(tail+4).equals(pda([Buffer.from('__event_authority')]))&&a(tail+5).equals(PERPS),'unapproved referral or program');
  const r=new Reader(ix.data);let counter;
  if(isOpen){
   invariant(expected.kind==='open','increase in a close transaction');
   const size=r.u64(),collateral=r.u64(),side=r.byte(),slippage=r.u64(),minimum=r.option(r.u64);counter=r.u64();
   invariant(size===BigInt(expected.size)&&collateral===BigInt(expected.collateral)&&side===1,'order size, collateral or side differs from quote');
   invariant(slippage>=BigInt(expected.mark)&&slippage<=BigInt(expected.maxPrice),'opening slippage exceeds limit');
   invariant(expected.inputToken==='SOL'&&expected.market==='SOL'||minimum!==null&&minimum>=BigInt(expected.minOut)&&minimum>0n,'swap minimum output exceeds allowed loss');increases++;
  }else{
   const collateral=r.u64(),size=r.u64();
   invariant(collateral===0n,'unexpected collateral withdrawal');
   let entire;
   if(modern){
    const type=r.byte(),slippage=r.option(r.u64),minimum=r.option(r.u64),trigger=r.option(r.u64),above=r.option(r.bool);entire=r.option(r.bool);counter=r.u64();
    invariant(expected.kind==='open'&&type===1&&trigger!==null&&slippage===null,'unexpected trigger request');
    invariant(minimum===null||minimum>=0n,'invalid swap minimum');
    if(above===true){invariant(trigger===BigInt(expected.tp),'incorrect take-profit');tp++;}
    else {invariant(above===false&&trigger===BigInt(expected.sl),'incorrect stop-loss');sl++;}
   }else{
    const slippage=r.u64(),minimum=r.option(r.u64);entire=r.option(r.bool);counter=r.u64();
    invariant(expected.kind==='close'&&slippage>=BigInt(expected.minPrice)&&slippage<=BigInt(expected.mark),'closing slippage exceeds limit');
    invariant(minimum!==null&&minimum>=BigInt(expected.minOut)&&minimum>0n,'close swap minimum output exceeds allowed loss');closes++;
   }
   invariant(entire===true&&(size===0n||size===BigInt(expected.size)),'partial close is not authorized');
  }
  r.end();const counterBytes=Buffer.alloc(8);counterBytes.writeBigUInt64LE(counter);
  const request=pda([Buffer.from('position_request'),position.toBuffer(),counterBytes,Buffer.from([isOpen?1:2])]);
  invariant(a(5).equals(request)&&a(6).equals(associated(request,mint)),'request or escrow destination mismatch');
  requests.push({address:request.toBase58(),trigger:modern});atas.set(associated(request,mint).toBase58(),request.toBase58()+':'+mint.toBase58());
 }
 invariant(expected.kind==='open'?increases===1&&tp===1&&sl===1&&closes===0:closes===1&&increases===0&&tp===0&&sl===0,'missing or duplicate order / TP / SL');
 invariant(new Set(requests.map(r=>r.address)).size===requests.length,'duplicate request address');
 for(const ix of message.instructions){
  if(ix.programId.equals(PERPS))continue;
  if(ix.programId.equals(ComputeBudgetProgram.programId)){
   const tag=ix.data[0];invariant(!computeTags.has(tag)&&ix.keys.length===0,'duplicate compute setting');computeTags.add(tag);
   if(tag===2&&ix.data.length===5){units=ix.data.readUInt32LE(1);invariant(units>0&&units<=1400000,'compute limit');}
   else if(tag===3&&ix.data.length===9){unitPrice=ix.data.readBigUInt64LE(1);}
   else invariant(false,'unsupported compute setting');continue;
  }
  if(ix.programId.equals(ATA)){
   invariant(ix.keys.length===6&&(ix.data.length===0||ix.data.length===1&&ix.data[0]===1),'unsupported associated token instruction');
   const keys=ix.keys.map(k=>k.pubkey.toBase58());invariant(keys[0]===owner.toBase58()&&atas.get(keys[1])===keys[2]+':'+keys[3]&&keys[4]===PublicKey.default.toBase58()&&keys[5]===TOKEN.toBase58(),'unexpected token account destination');continue;
  }
  if(expected.kind==='open'&&expected.inputToken==='SOL'&&ix.programId.equals(PublicKey.default)){
   invariant(ix.data.length===12&&ix.data.readUInt32LE(0)===2&&ix.keys.length===2&&ix.keys[0].pubkey.equals(owner)&&ix.keys[1].pubkey.equals(associated(owner,SOL)),'unexpected SOL transfer');wrapped+=ix.data.readBigUInt64LE(4);invariant(wrapped===BigInt(expected.collateral),'incorrect SOL wrapping amount');continue;
  }
  if(expected.kind==='open'&&expected.inputToken==='SOL'&&ix.programId.equals(TOKEN)){
   if(ix.data.length===1&&ix.data[0]===17){invariant(++syncs===1&&ix.keys.length===1&&ix.keys[0].pubkey.equals(associated(owner,SOL)),'unexpected native sync');}
   else if(ix.data.length===1&&ix.data[0]===9){invariant(++unwraps===1&&ix.keys.length===3&&ix.keys[0].pubkey.equals(associated(owner,SOL))&&ix.keys[1].pubkey.equals(owner)&&ix.keys[2].pubkey.equals(owner),'unexpected token account close');}
   else invariant(false,'unapproved token instruction');continue;
  }
  invariant(false,'unapproved program or standalone transfer');
 }
 invariant(unitPrice*BigInt(units||1400000)/1000000n<=2000000n,'priority fee exceeds 0.002 SOL');
 if(expected.inputToken==='SOL'&&expected.kind==='open')invariant(wrapped===BigInt(expected.collateral)&&syncs===1,'missing SOL funding');
 return {requests,position:position.toBase58()};
}

export function decodeRequest(data){
 invariant(Buffer.from(data).subarray(0,8).equals(discriminator('account:PositionRequest')),'invalid request account');
 const r=new Reader(data);r.offset=200;
 const change=r.byte(),type=r.byte(),side=r.byte();r.option(r.u64);r.option(r.u64);r.option(r.u64);
 const trigger=r.option(r.u64),above=r.option(r.bool),entire=r.option(r.bool),executed=r.bool();
 return {owner:new PublicKey(data.subarray(8,40)).toBase58(),position:new PublicKey(data.subarray(104,136)).toBase58(),change,type,side,trigger,above,entire,executed};
}
