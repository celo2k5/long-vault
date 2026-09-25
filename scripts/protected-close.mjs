import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import anchor from '@coral-xyz/anchor';
const {BorshCoder,BN}=anchor;
import {TransactionInstruction,TransactionMessage,VersionedTransaction,PublicKey,ComputeBudgetProgram} from '@solana/web3.js';
import {PERPS,POOL,TOKEN,ATA,CUSTODY,pda,associated,positionAddress,inspectPerpsTransaction} from './perps-policy.mjs';
const idl=JSON.parse(readFileSync(new URL('../vendor/perps-idl.json',import.meta.url))),coder=new BorshCoder(idl);
// Close to the market's collateral without a swap. The keeper enforces the
// price floor; conversion to SOL is a separate bounded swap after finality.
export async function prepareProtectedClose(connection,expected){
 if(expected.kind!=='close'||BigInt(expected.minOut)<=0n||BigInt(expected.minPrice)<=0n)throw Error('Protected close requires positive price and payout limits.');
 const owner=new PublicKey(expected.owner),position=positionAddress(owner,expected.market),counter=randomBytes(8);
 const request=pda([Buffer.from('position_request'),position.toBuffer(),counter,Buffer.from([2])]);
 const mint=new PublicKey(expected.receiveMint);
 const accounts=[owner,associated(owner,mint),pda([Buffer.from('perpetuals')]),POOL,position,request,associated(request,mint),new PublicKey(CUSTODY[expected.market]),new PublicKey(CUSTODY[expected.market]),mint,PERPS,TOKEN,ATA,PublicKey.default,pda([Buffer.from('__event_authority')]),PERPS];
 const def=idl.instructions.find(x=>x.name==='createDecreasePositionMarketRequest');
 const ix=new TransactionInstruction({programId:PERPS,keys:accounts.map((pubkey,i)=>({pubkey,isSigner:def.accounts[i].isSigner,isWritable:def.accounts[i].isMut})),data:coder.instruction.encode(def.name,{params:{collateralUsdDelta:new BN(0),sizeUsdDelta:new BN(expected.size),priceSlippage:new BN(String(expected.minPrice)),jupiterMinimumOut:null,entirePosition:true,counter:new BN(counter,'le')}})});
 const setup=new TransactionInstruction({programId:ATA,keys:[{pubkey:owner,isSigner:true,isWritable:true},{pubkey:associated(owner,mint),isSigner:false,isWritable:true},{pubkey:owner,isSigner:false,isWritable:false},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:PublicKey.default,isSigner:false,isWritable:false},{pubkey:TOKEN,isSigner:false,isWritable:false}],data:Buffer.from([1])});
 const {blockhash,lastValidBlockHeight}=await connection.getLatestBlockhash('confirmed');
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),setup,ix]}).compileToV0Message());
 inspectPerpsTransaction(tx,[],expected);
 return {tx,lastHeight:lastValidBlockHeight};
}



