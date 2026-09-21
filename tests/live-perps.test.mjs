import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Keypair,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {PERPS,POOL,TOKEN,ATA,USDC,CUSTODY,pda,associated,positionAddress,discriminator,inspectPerpsTransaction,decodeRequest} from '../scripts/perps-policy.mjs';
import {TradeJournal,createLivePerps,base58} from '../scripts/live-perps.mjs';
import {defaults} from '../.sites-runtime/lib/engine.mjs';

const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const some=n=>Buffer.concat([Buffer.from([1]),u64(n)]);
const none=()=>Buffer.from([0]);
const yes=()=>Buffer.from([1,1]);
function fixture(){
 const wallet=Keypair.generate(),owner=wallet.publicKey,position=positionAddress(owner,'SOL');
 const expected={kind:'open',owner:owner.toBase58(),market:'SOL',position:position.toBase58(),inputToken:'USDC',size:'50000000',collateral:'10000000',mark:100000000,maxPrice:100500000,minPrice:99500000,tp:120000000,sl:95000000,minOut:'99500000'};
 const make=(type,counter=1)=>{
  const modern=type==='tp'||type==='sl',increase=type==='open',request=pda([Buffer.from('position_request'),position.toBuffer(),u64(counter),Buffer.from([increase?1:2])]);
  let keys=[owner,associated(owner),pda([Buffer.from('perpetuals')]),POOL,position,request,associated(request),new PublicKey(CUSTODY.SOL)];
  if(modern)keys.push(Keypair.generate().publicKey,Keypair.generate().publicKey);
  keys.push(new PublicKey(CUSTODY.SOL),USDC,PERPS,TOKEN,ATA,PublicKey.default,pda([Buffer.from('__event_authority')]),PERPS);
  const name=increase?'create_increase_position_market_request':modern?'create_decrease_position_request2':'create_decrease_position_market_request';
  const params=increase?[u64(expected.size),u64(expected.collateral),Buffer.from([1]),u64(expected.maxPrice),some(expected.minOut),u64(counter)]:modern?[u64(0),u64(0),Buffer.from([1]),none(),none(),some(type==='tp'?expected.tp:expected.sl),Buffer.from([1,type==='tp'?1:0]),yes(),u64(counter)]:[u64(0),u64(0),u64(expected.minPrice),some(expected.minOut),yes(),u64(counter)];
  return new TransactionInstruction({programId:PERPS,keys:keys.map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:i<7})),data:Buffer.concat([discriminator('global:'+name),...params])});
 };
 const instructions=[make('open',1),make('tp',2),make('sl',3)];
 const tx=(ixs=instructions)=>new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:PublicKey.default.toBase58(),instructions:ixs}).compileToV0Message());
 return {wallet,owner,position,expected,make,instructions,tx};
}
test('instruction policy accepts a bounded long with exact full-position TP and SL',()=>{
 const f=fixture(),result=inspectPerpsTransaction(f.tx(),[],f.expected);assert.equal(result.requests.length,3);assert.equal(result.requests.filter(r=>r.trigger).length,2);
 assert.equal(inspectPerpsTransaction(f.tx([f.make('close',4)]),[],{...f.expected,kind:'close'}).requests.length,1);
});
test('instruction policy rejects stolen destinations, unauthorized transfers and absent protection',()=>{
 const f=fixture();assert.throws(()=>inspectPerpsTransaction(f.tx(f.instructions.slice(0,2)),[],f.expected),/missing/);
 assert.throws(()=>inspectPerpsTransaction(f.tx([...f.instructions,SystemProgram.transfer({fromPubkey:f.owner,toPubkey:Keypair.generate().publicKey,lamports:1})]),[],f.expected),/unapproved/);
 const open=f.make('open');open.keys[1].pubkey=associated(Keypair.generate().publicKey);
 assert.throws(()=>inspectPerpsTransaction(f.tx([open,...f.instructions.slice(1)]),[],f.expected),/destination/);
 assert.throws(()=>inspectPerpsTransaction(f.tx(),[],{...f.expected,collateral:'1'}),/collateral/);
 assert.throws(()=>inspectPerpsTransaction(f.tx(),[],{...f.expected,tp:f.expected.tp+1}),/take-profit/);
 assert.throws(()=>inspectPerpsTransaction(f.tx(),[],{...f.expected,minOut:'999999999'}),/swap minimum/);
});
test('instruction policy caps priority fees and rejects existing signatures and unknown instruction extensions',()=>{
 const f=fixture();assert.throws(()=>inspectPerpsTransaction(f.tx([ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000000}),...f.instructions]),[],f.expected),/priority fee/);
 const signed=f.tx();signed.sign([f.wallet]);assert.throws(()=>inspectPerpsTransaction(signed,[],f.expected),/already signed/);
 const open=f.make('open');open.data=Buffer.concat([open.data,Buffer.from([1])]);assert.throws(()=>inspectPerpsTransaction(f.tx([open,...f.instructions.slice(1)]),[],f.expected),/extension/);
});
test('journal serializes orders, survives service reloads and rejects key substitution',()=>{
 const db=new DatabaseSync(':memory:'),journal=new TradeJournal(db),action={kind:'open',market:'SOL'};
 assert.equal(journal.reserve('order-one',action).duplicate,false);assert.equal(journal.reserve('order-one',action).duplicate,true);
 assert.throws(()=>journal.reserve('order-one',{kind:'close',market:'SOL'}),/different/);
 assert.throws(()=>journal.reserve('order-two',action),/pending/);
 journal.signed('order-one',{expected:{},wire:'exact signed bytes',signature:'signature',lastHeight:10});
 assert.equal(new TradeJournal(db).get('order-one').wire,'exact signed bytes');db.close();
});
test('ambiguous sends and restarts only resend the original signed transaction',async()=>{
 const db=new DatabaseSync(':memory:'),f=fixture(),sent=[];
 const env={ADMIN_PASSWORD:'test-only-password-not-for-deployment',LIVE_TRADING_ENABLED:'true',DATA_DIR:'/test-only',SOLANA_RPC_URL:'https://example.invalid',DEV_WALLET_PRIVATE_KEY:JSON.stringify([...f.wallet.secretKey])};
 const config=async()=>({...defaults,vault:f.owner.toBase58(),tokenMint:USDC.toBase58()});
 let preparations=0;
 const connection={async getGenesisHash(){return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';},async getSignatureStatuses(){return {value:[null]};},async getBlockHeight(){return 1;},async sendRawTransaction(bytes){sent.push(Buffer.from(bytes).toString('base64'));throw Error('RPC disconnected after accepting transaction');}};
 const dependencies={rpc:()=>connection,prepare:async()=>{preparations++;return {tx:f.tx(),expected:f.expected,lastHeight:100};}};
 let service=createLivePerps({sqlite:db,env,config,dependencies});
 try{
  await service.execute({kind:'resume'});await service.execute({kind:'open',market:'SOL'},'test-order');
  assert.equal(service.journal.get('test-order').status,'signed');assert.equal(sent.length,1);
  service.close();service=createLivePerps({sqlite:db,env,config,dependencies});await service.reconcile();
  assert.equal(preparations,1);assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);
  await assert.rejects(service.execute({kind:'open',market:'BTC'},'other-order'),/pending|cooldown/);
  service.journal.pause(true);await service.reconcile();assert.equal(sent.length,2);
  assert.equal(JSON.stringify(await service.status()).includes(env.DEV_WALLET_PRIVATE_KEY),false);
 }finally{service.close();db.close();}
});
test('expired signatures remain unresolved and block duplicate spending',async()=>{
 const db=new DatabaseSync(':memory:'),f=fixture(),env={ADMIN_PASSWORD:'test-only-password-not-for-deployment',LIVE_TRADING_ENABLED:'true',DATA_DIR:'/test',SOLANA_RPC_URL:'https://example.invalid',DEV_WALLET_PRIVATE_KEY:JSON.stringify([...f.wallet.secretKey])};
 const connection={async getGenesisHash(){return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';},async getSignatureStatuses(){return {value:[null]};},async getBlockHeight(){return 101;},async sendRawTransaction(){assert.fail('Expired transaction must not be sent');}};
 const service=createLivePerps({sqlite:db,env,config:async()=>({...defaults,vault:f.owner.toBase58(),tokenMint:USDC.toBase58()}),dependencies:{rpc:()=>connection,prepare:async()=>({tx:f.tx(),expected:f.expected,lastHeight:100})}});
 try{await service.execute({kind:'resume'});await service.execute({kind:'open',market:'SOL'},'expired-order');assert.equal(service.journal.get('expired-order').status,'unknown');assert.equal(service.journal.paused(),true);}finally{service.close();db.close();}
});
test('no private provider URL or private key is stored in preparation failure messages',async()=>{
 const db=new DatabaseSync(':memory:'),f=fixture(),env={ADMIN_PASSWORD:'test-only-password-not-for-deployment',LIVE_TRADING_ENABLED:'true',DATA_DIR:'/test',SOLANA_RPC_URL:'https://example.invalid',DEV_WALLET_PRIVATE_KEY:JSON.stringify([...f.wallet.secretKey])};
 const service=createLivePerps({sqlite:db,env,config:async()=>({...defaults,vault:f.owner.toBase58(),tokenMint:USDC.toBase58()}),dependencies:{prepare:async()=>{throw Error('https://provider/?key=private-provider-token');}}});
 try{await service.execute({kind:'resume'});const result=await service.execute({kind:'open',market:'SOL'},'failed-order');assert.equal(result.orders[0].status,'failed');assert.equal(JSON.stringify(result).includes('private-provider-token'),false);}finally{service.close();db.close();}
});

test('cycle allocations are fixed before the first trade and survive partial progress',async()=>{
 const db=new DatabaseSync(':memory:'),f=fixture(),prepared=[];
 const env={ADMIN_PASSWORD:'test-only-password-not-for-deployment',LIVE_TRADING_ENABLED:'true',DATA_DIR:'/test',SOLANA_RPC_URL:'https://example.invalid',DEV_WALLET_PRIVATE_KEY:JSON.stringify([...f.wallet.secretKey])};
 const config=async()=>({...defaults,vault:f.owner.toBase58(),tokenMint:USDC.toBase58()});
 const connection={async getGenesisHash(){return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';},async getMultipleAccountsInfo(){return [null,null,null];},async getSignatureStatuses(){return {value:[null]};},async getBlockHeight(){return 1;},async sendRawTransaction(bytes){return base58(VersionedTransaction.deserialize(bytes).signatures[0]);}};
 let balance=100;
 const dependencies={rpc:()=>connection,api:async()=>({count:0,dataList:[]}),report:async()=>({creator:f.owner.toBase58(),rewardsSol:0,walletSol:0.15,usdc:balance,prices:{SOL:100}}),prepare:async action=>{prepared.push(action);return {tx:f.tx(),expected:f.expected,lastHeight:100};}};
 const service=createLivePerps({sqlite:db,env,config,dependencies});
 try{
  await service.execute({kind:'resume'});await service.advanceCycle();let state=(await service.status()).cycle;assert.equal(state.phase,'opening');assert.deepEqual(state.plans.map(p=>p.budget),[40000000,30000000,30000000]);
  await service.advanceCycle();assert.equal(prepared.length,1);assert.equal(prepared[0].budget,40000000);
  balance=60;service.journal.update(state.id+'-0','filled','test adapter reports a verified fill');await service.advanceCycle();await service.advanceCycle();
  assert.equal(prepared.length,2);assert.equal(prepared[1].budget,30000000);assert.equal(prepared[1].market,'ETH');
  service.journal.update(state.id+'-1','failed','test adapter rejects insufficient collateral');await service.advanceCycle();assert.equal(service.journal.paused(),true);assert.equal((await service.status()).cycle.phase,'error');
 }finally{service.close();db.close();}
});
test('cycles require the developer to be the verified creator and pause on mismatch',async()=>{
 const db=new DatabaseSync(':memory:'),f=fixture();
 const env={ADMIN_PASSWORD:'test-only-password-not-for-deployment',LIVE_TRADING_ENABLED:'true',DATA_DIR:'/test',SOLANA_RPC_URL:'https://example.invalid',DEV_WALLET_PRIVATE_KEY:JSON.stringify([...f.wallet.secretKey])};
 const service=createLivePerps({sqlite:db,env,config:async()=>({...defaults,vault:f.owner.toBase58(),tokenMint:USDC.toBase58()}),dependencies:{rpc:()=>({async getGenesisHash(){return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';},async getMultipleAccountsInfo(){return [null,null,null];}}),api:async()=>({count:0,dataList:[]}),report:async()=>({creator:Keypair.generate().publicKey.toBase58(),rewardsSol:1,walletSol:1,usdc:100,prices:{SOL:100}}),prepare:async()=>assert.fail('Mismatched creator must never prepare transactions')}});
 try{await service.execute({kind:'resume'});await service.advanceCycle();assert.equal(service.journal.paused(),true);assert.match((await service.status()).cycle.message,/creator/);}finally{service.close();db.close();}
});

test('real order preparation validates quote, chain accounts and simulation before signing',async()=>{
 for(const tamper of [false,true]){
  const db=new DatabaseSync(':memory:'),f=fixture();let sends=0,simulations=0;
  const data=Buffer.alloc(165);USDC.toBuffer().copy(data,0);f.owner.toBuffer().copy(data,32);data.writeBigUInt64LE(10000000n,64);
  const config=async()=>({...defaults,vault:f.owner.toBase58(),tokenMint:USDC.toBase58(),minRewardUsd:10,allocation:{BTC:0,ETH:0,SOL:100}});
  const connection={async getGenesisHash(){return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';},async getBalance(){return 200000000;},async getAccountInfo(address){return address.equals(associated(f.owner))?{data,owner:TOKEN}:null;},async getProgramAccounts(){return [];},async getBlockHeight(){return 1;},async getFeeForMessage(){return {value:5000};},async simulateTransaction(){simulations++;return {value:{err:null,accounts:[{lamports:199995000}]}};},async getSignatureStatuses(){return {value:[null]};},async sendRawTransaction(bytes){sends++;return base58(VersionedTransaction.deserialize(bytes).signatures[0]);}};
  const api=async(path,body)=>{
   if(path.startsWith('positions?'))return {count:0,dataList:[]};if(path.startsWith('market-stats'))return {price:'100'};
   assert.equal(body.inputTokenAmount,'10000000');assert.equal(body.tpsl.length,2);
   const tx=f.tx(tamper?[...f.instructions,SystemProgram.transfer({fromPubkey:f.owner,toPubkey:Keypair.generate().publicKey,lamports:1000})]:f.instructions);
   return {positionPubkey:f.position.toBase58(),serializedTxBase64:Buffer.from(tx.serialize()).toString('base64'),txMetadata:{blockhash:PublicKey.default.toBase58(),lastValidBlockHeight:'100'},quote:{side:'long',sizeUsdDelta:'50000000',averagePriceUsd:'100000000',liquidationPriceUsd:'70000000',leverage:'5'}};
  };
  const service=createLivePerps({sqlite:db,env:{ADMIN_PASSWORD:'test-only-password-not-for-deployment',LIVE_TRADING_ENABLED:'true',DATA_DIR:'/test',SOLANA_RPC_URL:'https://example.invalid',DEV_WALLET_PRIVATE_KEY:JSON.stringify([...f.wallet.secretKey])},config,dependencies:{rpc:()=>connection,api}});
  try{await service.execute({kind:'resume'});const result=await service.execute({kind:'open',market:'SOL'},'validated-order');assert.equal(result.orders[0].status,tamper?'failed':'submitted',result.orders[0].message);assert.equal(sends,tamper?0:1);assert.equal(simulations,tamper?0:1);}finally{service.close();db.close();}
 }
});

test('SOL funding may wrap only the exact authorized amount into the developer ATA',()=>{
 const f=fixture(),mint=new PublicKey('So11111111111111111111111111111111111111112'),open=f.make('open');
 open.keys[1].pubkey=associated(f.owner,mint);open.keys[6].pubkey=associated(open.keys[5].pubkey,mint);open.keys[9].pubkey=mint;open.data.writeBigUInt64LE(100000000n,16);
 const wrap=SystemProgram.transfer({fromPubkey:f.owner,toPubkey:associated(f.owner,mint),lamports:100000000});
 const sync=new TransactionInstruction({programId:TOKEN,keys:[{pubkey:associated(f.owner,mint),isSigner:false,isWritable:true}],data:Buffer.from([17])});
 const expected={...f.expected,inputToken:'SOL',collateral:'100000000'};
 assert.equal(inspectPerpsTransaction(f.tx([wrap,sync,open,...f.instructions.slice(1)]),[],expected).requests.length,3);
 const stolen=SystemProgram.transfer({fromPubkey:f.owner,toPubkey:Keypair.generate().publicKey,lamports:100000000});
 assert.throws(()=>inspectPerpsTransaction(f.tx([stolen,sync,open,...f.instructions.slice(1)]),[],expected),/SOL transfer/);
 assert.throws(()=>inspectPerpsTransaction(f.tx([wrap,sync,open,...f.instructions.slice(1)]),[],{...expected,collateral:'100000001'}),/collateral/);
});
