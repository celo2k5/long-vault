import {createHash,randomUUID} from 'node:crypto';
import {PublicKey,VersionedTransaction,TransactionMessage,ComputeBudgetProgram} from '@solana/web3.js';
import pumpSdk from '../node_modules/@pump-fun/pump-sdk/dist/index.js';
import {z} from 'zod';
import {loadDeveloperWallet,developerWalletStatus} from '../.sites-runtime/lib/dev-wallet.mjs';
import {rpcConnection,jupiter,parsePositions,readMainnet} from '../.sites-runtime/lib/mainnet.mjs';
import {validateConfig,MARKETS} from '../.sites-runtime/lib/engine.mjs';
import {PERPS,USDC,associated,positionAddress,inspectPerpsTransaction,decodeRequest,discriminator} from './perps-policy.mjs';

import {prepareBuyback,closeReceipt,buybackBudget,tokenDelta} from './buybacks.mjs';

const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function base58(bytes){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const b of bytes)n=n*256n+BigInt(b);let result='';while(n){result=alphabet[Number(n%58n)]+result;n/=58n;}for(const b of bytes){if(b!==0)break;result='1'+result;}return result;}
const rawAmount=z.string().regex(/^\d+$/).refine(s=>Number.isSafeInteger(Number(s)));
const responseSchema=z.object({positionPubkey:z.string(),serializedTxBase64:z.string().min(80).max(20000),txMetadata:z.object({blockhash:z.string(),lastValidBlockHeight:rawAmount}),quote:z.object({side:z.literal('long'),sizeUsdDelta:rawAmount}).passthrough()});
const activeSql="('preparing','signed','submitted','confirmed','unknown')";
const safeError=e=>e?.safe===true?e.message:'Order could not be prepared. Check RPC, balances, API availability and transaction policy; no replacement order was sent.';
function fail(message){throw Object.assign(Error(message),{safe:true});}
export class TradeJournal{
 constructor(sqlite){this.db=sqlite;sqlite.exec(`CREATE TABLE IF NOT EXISTS live_control (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 1); INSERT OR IGNORE INTO live_control(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS live_orders (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, market TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, expected TEXT, wire TEXT, signature TEXT, last_height INTEGER, message TEXT NOT NULL DEFAULT '');
 CREATE UNIQUE INDEX IF NOT EXISTS single_live_order ON live_orders((1)) WHERE status IN ${activeSql};`);}
 get(id){return this.db.prepare('SELECT * FROM live_orders WHERE id=?').get(id);}
 active(){return this.db.prepare(`SELECT * FROM live_orders WHERE status IN ${activeSql} LIMIT 1`).get();}
 paused(){return !!this.db.prepare('SELECT paused FROM live_control WHERE id=1').get().paused;}
 pause(value){this.db.prepare('UPDATE live_control SET paused=? WHERE id=1').run(value?1:0);}
 list(){return this.db.prepare('SELECT id,kind,market,status,created,updated,signature,message FROM live_orders ORDER BY created DESC LIMIT 100').all();}
 reserve(id,action){
  if(!/^[a-zA-Z0-9_-]{8,120}$/.test(id))fail('A valid command key is required.');
  const fp=fingerprint(action),prior=this.get(id);if(prior){if(prior.fingerprint!==fp)fail('Command key already belongs to a different order.');return {row:prior,duplicate:true};}
  if(this.active())fail('An order is still pending. Wait for reconciliation before placing another.');
  try{this.db.prepare("INSERT INTO live_orders(id,fingerprint,kind,market,status,created,updated) VALUES(?,?,?,?,'preparing',?,?)").run(id,fp,action.kind,action.market,Date.now(),Date.now());}catch{fail('Another order is already in progress.');}
  return {row:this.get(id),duplicate:false};
 }
 update(id,status,message,from){return this.db.prepare('UPDATE live_orders SET status=?,message=?,updated=? WHERE id=?'+(from?' AND status=?':'')).run(status,message,Date.now(),id,...(from?[from]:[])).changes;}
 signed(id,{expected,wire,signature,lastHeight}){
  // Commit the exact signed bytes BEFORE any network broadcast. Never rebuild on a retry.
  const changed=this.db.prepare("UPDATE live_orders SET status='signed',expected=?,wire=?,signature=?,last_height=?,updated=?,message='Signed; awaiting submission' WHERE id=? AND status='preparing'").run(JSON.stringify(expected),wire,signature,lastHeight,Date.now(),id).changes;
  if(changed!==1)fail('Order preparation was cancelled.');
 }
}
function chainSize(account,owner,market){
 if(!account)return 0n;
 const b=account.data;if(!account.owner.equals(PERPS)||b.length<177||!b.subarray(0,8).equals(discriminator('account:Position'))||new PublicKey(b.subarray(8,40)).toBase58()!==owner||b[152]!==1)fail('Position authority could not be verified on-chain.');
 return b.readBigUInt64LE(161);
}
export function createLivePerps({sqlite,env,config,dependencies={}}){
 const journal=new TradeJournal(sqlite),rpc=dependencies.rpc||(()=>rpcConnection(env)),api=dependencies.api||((path,body)=>jupiter(env,path,body));
 sqlite.exec("CREATE TABLE IF NOT EXISTS live_cycle (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL); INSERT OR IGNORE INTO live_cycle VALUES(1,'{\"phase\":\"idle\",\"nextAt\":0}');");
 const cycle=()=>JSON.parse(sqlite.prepare('SELECT state FROM live_cycle WHERE id=1').get().state);
 const setCycle=value=>sqlite.prepare('UPDATE live_cycle SET state=? WHERE id=1').run(JSON.stringify(value));
 // A preparation has no persisted signature and therefore could never be broadcast.
 // CAS in signed() fences any older process still finishing that preparation.
 sqlite.prepare("UPDATE live_orders SET status='failed',message='Preparation interrupted before signing; safe to submit a new command',updated=? WHERE status='preparing'").run(Date.now());
 sqlite.exec("CREATE TABLE IF NOT EXISTS close_receipts (signature TEXT NOT NULL, request TEXT NOT NULL, cycle TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(signature,request));");
 let reconciling=false,cycling=false,closed=false;
 function reasons(c){const missing=[];if(!env.ADMIN_PASSWORD||env.ADMIN_PASSWORD.length<20||env.ADMIN_PASSWORD.length>256)missing.push('Configure a valid Admin password before live execution.');if(env.LIVE_TRADING_ENABLED!=='true')missing.push('Set LIVE_TRADING_ENABLED=true in Railway to permit live orders.');if(!env.DATA_DIR)missing.push('Attach a persistent volume and set DATA_DIR.');if(!env.SOLANA_RPC_URL)missing.push('Set SOLANA_RPC_URL.');const wallet=developerWalletStatus(env.DEV_WALLET_PRIVATE_KEY,c.vault);if(wallet.status!=='configured')missing.push(wallet.message);if(!c.vault)missing.push('Save the developer wallet as the vault address.');if(!c.tokenMint)missing.push('Save the token CA.');return missing;}
 async function status(){const c=await config();return {enabled:reasons(c).length===0,paused:journal.paused(),reasons:reasons(c),cycle:cycle(),orders:journal.list()};}
 async function verifiedConnection(){const connection=rpc();if(await connection.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')fail('Live perpetuals require a verified Solana mainnet RPC.');return connection;}
 async function prepare(action,c){
  validateConfig(c);const connection=await verifiedConnection();
  if(action.kind==='buyback')return prepareBuyback(connection,env,c,BigInt(action.amount),dependencies.swapApi);
  if(action.kind==='claim'){
   const report=await (dependencies.report?dependencies.report(c):readMainnet(c,env));
   if(report.creator!==c.vault||report.rewardsSol===null||report.rewardsSol<=0)fail('No verified claimable fees for this developer wallet and token.');
   if(report.checks.some(check=>check.name==='Pump creator rewards'&&check.status!=='ok'))fail('Creator fee authority could not be verified.');
   if(report.walletSol===null||report.walletSol<0.01)fail('The developer wallet needs 0.01 SOL for claim transaction fees.');
   const sdk=new pumpSdk.OnlinePumpSdk(connection);
   // Construct locally with the pinned Pump SDK. Never sign instructions supplied by a caller.
   const instructions=await sdk.collectCoinCreatorFeeInstructions(new PublicKey(c.vault),new PublicKey(c.vault));
   const latest=await connection.getLatestBlockhash();
   const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(c.vault),recentBlockhash:latest.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),...instructions]}).compileToV0Message());
   if(tx.message.header.numRequiredSignatures!==1)fail('Unexpected claim signer.');
   const simulation=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:false,accounts:{encoding:'base64',addresses:[c.vault]}});
   if(simulation.value.err||!simulation.value.accounts?.[0]||simulation.value.accounts[0].lamports<Math.floor(report.walletSol*1e9)-1000000)fail('Creator fee claim simulation failed.');
   return {tx,expected:{kind:'claim',owner:c.vault,requests:[]},lastHeight:latest.lastValidBlockHeight};
  }
  const owner=c.vault,position=positionAddress(owner,action.market);
  const [positions,sol,tokenAccount,onchain,pending,market]=await Promise.all([
   api('positions?walletAddress='+encodeURIComponent(owner)).then(parsePositions),connection.getBalance(new PublicKey(owner)),connection.getAccountInfo(associated(owner)),connection.getAccountInfo(position),
   connection.getProgramAccounts(PERPS,{filters:[{memcmp:{offset:0,bytes:base58(discriminator('account:PositionRequest'))}},{memcmp:{offset:8,bytes:owner}}]}),api('market-stats?mint='+({BTC:'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',ETH:'7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',SOL:'So11111111111111111111111111111111111111112'}[action.market]))
  ]);
  if(sol<40000000)fail('Keep at least 0.04 SOL in the developer wallet for rent and transaction fees.');
  if(pending.some(p=>{const request=decodeRequest(p.account.data);return !request.executed&&(request.type===0||action.kind==='open'&&request.position===position.toBase58());}))fail('The wallet has a pending market request or leftover TP/SL for this position. Resolve it in Jupiter first.');
  const mark=Number(market.price);if(!Number.isFinite(mark)||mark<=0||!Number.isSafeInteger(Math.round(mark*1e6)))fail('Market price is unavailable.');
  const size=chainSize(onchain,owner,action.market),existing=positions.find(p=>p.address===position.toBase58());
  const expected={kind:action.kind,market:action.market,owner,inputToken:action.inputToken||'USDC',position:position.toBase58(),mark:Math.round(mark*1e6),maxPrice:Number(BigInt(Math.round(mark*1e6))*BigInt(10000+c.slippageBps)/10000n),minPrice:Number((BigInt(Math.round(mark*1e6))*BigInt(10000-c.slippageBps)+9999n)/10000n),size:'0',collateral:'0',tp:Math.round(mark*(1+c.takeProfit/100/c.leverage)*1e6),sl:Math.round(mark*(1-c.stopLoss/100/c.leverage)*1e6)};
  let raw;
  if(action.kind==='open'){
   if(existing||size>0n)fail('This market already has a position. Close it before opening another.');
   let amount=0n,price=1,decimals=1e6;
   if(expected.inputToken==='SOL'){
    const solMarket=await api('market-stats?mint=So11111111111111111111111111111111111111112');price=Number(solMarket.price);decimals=1e9;
    if(!Number.isFinite(price)||price<=0)fail('SOL price is unavailable.');amount=BigInt(Math.max(0,sol-40000000));
   }else{
    if(!tokenAccount||tokenAccount.data.length!==165||tokenAccount.owner.toBase58()!=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'||!new PublicKey(tokenAccount.data.subarray(0,32)).equals(USDC)||new PublicKey(tokenAccount.data.subarray(32,64)).toBase58()!==owner)fail('Fund the developer wallet USDC associated token account first.');
    amount=tokenAccount.data.readBigUInt64LE(64);
   }
   if(amount>BigInt(Number.MAX_SAFE_INTEGER))fail('Wallet balance exceeds supported precision.');
   const balance=Number(amount)/decimals*price;if(action.budget===undefined&&balance<c.minRewardUsd)fail('Balance is below the configured minimum cycle capital.');
   const collateral=action.budget??Math.floor(Math.min(balance*c.allocation[action.market]/100,c.maxPositionUsd/c.leverage)/price*decimals);
   if(!Number.isSafeInteger(collateral)||collateral>Number(amount)||collateral/decimals*price>c.maxPositionUsd/c.leverage*1.01||collateral/decimals*price<10)fail('The allocation must cover at least $10 collateral within the position limit.');
   expected.collateral=String(collateral);
   expected.minOut=String(Math.floor(collateral/decimals*price/mark*({SOL:1e9,BTC:1e8,ETH:1e8}[action.market])*(1-c.slippageBps/10000)));
   raw=await api('positions/increase',{asset:action.market,inputToken:expected.inputToken,inputTokenAmount:String(collateral),side:'long',maxSlippageBps:String(c.slippageBps),leverage:String(c.leverage),walletAddress:owner,tpsl:[{receiveToken:'USDC',triggerPrice:String(expected.tp),requestType:'tp'},{receiveToken:'USDC',triggerPrice:String(expected.sl),requestType:'sl'}]});
  }else{
   if(!existing||existing.side!=='long'||size===0n)fail('No verified long position exists in this market.');
   expected.size=size.toString();
   expected.minOut=String(Math.max(1,Math.floor(Math.max(0,existing.collateralUsd+existing.pnlUsd)*(1-c.slippageBps/10000)*1e6)));
   raw=await api('positions/decrease',{positionPubkey:position.toBase58(),receiveToken:'USDC',entirePosition:true,maxSlippageBps:String(c.slippageBps)});
  }
  const quote=responseSchema.parse(raw);if(quote.positionPubkey!==expected.position)fail('Jupiter returned a different position.');
  if(action.kind==='open'){
   const q=quote.quote,entry=Number(rawAmount.parse(q.averagePriceUsd)),liquidation=Number(rawAmount.parse(q.liquidationPriceUsd)),leverage=Number(q.leverage),notional=Number(q.sizeUsdDelta);
   if(!Number.isFinite(leverage)||leverage<1||leverage>c.leverage*1.01||notional<=0||notional>c.maxPositionUsd*1e6||entry<=0||Math.abs(entry/expected.mark-1)*10000>c.slippageBps||liquidation<=0||liquidation>=expected.sl||expected.sl>=entry||expected.tp<=entry)fail('Quote exceeds size, leverage, slippage or liquidation limits.');
   expected.size=q.sizeUsdDelta;
  }
  const tx=VersionedTransaction.deserialize(Buffer.from(quote.serializedTxBase64,'base64'));
  if(tx.message.recentBlockhash!==quote.txMetadata.blockhash||await connection.getBlockHeight()>Number(quote.txMetadata.lastValidBlockHeight))fail('Jupiter transaction has expired or has inconsistent metadata.');
  const tables=await Promise.all(tx.message.addressTableLookups.map(async lookup=>{const result=await connection.getAddressLookupTable(lookup.accountKey);if(!result.value)fail('Transaction lookup table unavailable.');return result.value;}));
  let inspection;try{inspection=inspectPerpsTransaction(tx,tables,expected);}catch(e){fail(e.message);}
  expected.requests=inspection.requests;
  const fee=await connection.getFeeForMessage(tx.message);if(fee.value===null||fee.value>2100000)fail('Network fee exceeds 0.0021 SOL.');
  const simulation=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[owner]}});
  if(simulation.value.err)fail('On-chain simulation failed. No transaction was signed.');
  const after=simulation.value.accounts?.[0],funding=expected.inputToken==='SOL'&&action.kind==='open'?Number(expected.collateral):0;if(!after||sol-after.lamports>funding+35000000||after.lamports<5000000)fail('Simulation exceeds the SOL spending limit or leaves too little fee reserve.');
  return {tx,expected,lastHeight:Number(quote.txMetadata.lastValidBlockHeight)};
 }
 async function reconcile(){
  if(reconciling||closed)return;reconciling=true;
  try{
   const row=journal.active();if(!row||row.status==='preparing')return;
   const c=await config(),expected=JSON.parse(row.expected);const connection=await verifiedConnection();
   const result=(await connection.getSignatureStatuses([row.signature],{searchTransactionHistory:true})).value[0];
   if(result?.err&&result.confirmationStatus==='finalized'){journal.update(row.id,'failed','Transaction failed on-chain; no fill was created.');return;}
   if(result?.confirmationStatus==='finalized'){
    if(row.kind==='buyback'){
     const receipt=await connection.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
     if(!receipt)return;
     if(tokenDelta(receipt,expected.source,USDC.toBase58(),expected.owner)!==-BigInt(expected.amount)||tokenDelta(receipt,expected.destination,expected.mint,expected.owner)<BigInt(expected.minimum)){
      journal.pause(true);journal.update(row.id,'unknown','Buyback finalized but received tokens could not be verified. Inspect the original signature.');return;
     }
     journal.update(row.id,'filled','Realized profit bought back into the configured token; receipt finalized.');return;
    }
    if(row.kind==='claim'){journal.update(row.id,'filled','Creator fee claim finalized on-chain.');return;}
    const info=await connection.getAccountInfo(new PublicKey(expected.position),'finalized'),size=chainSize(info,expected.owner,expected.market);
    const requests=await connection.getMultipleAccountsInfo(expected.requests.map(r=>new PublicKey(r.address)),'finalized');
    if(requests.some(r=>r&&!r.owner.equals(PERPS)))fail('Unexpected request account owner.');
    const requestPending=requests.some((r,i)=>r&&!expected.requests[i].trigger&&!decodeRequest(r.data).executed);
    if(!requestPending&&row.kind==='close'&&size===0n){journal.update(row.id,'filled','Position closed on-chain.');return;}
    if(row.kind==='open'&&!requestPending&&size===0n&&requests.every(r=>!r||decodeRequest(r.data).executed)){
     journal.update(row.id,'settled','Request finalized and settled; no open position or active trigger remains. This does not establish realized profit.');return;
    }
    if(row.kind==='open'&&!requestPending&&size>0n){
     const protections=requests.filter((r,i)=>r&&expected.requests[i].trigger).map(r=>decodeRequest(r.data));
     const protectedPosition=protections.some(r=>r.type===1&&r.above===true&&r.trigger===BigInt(expected.tp)&&r.entire&&!r.executed)&&protections.some(r=>r.type===1&&r.above===false&&r.trigger===BigInt(expected.sl)&&r.entire&&!r.executed);
     if(protectedPosition){journal.update(row.id,'filled','Long is open; on-chain TP and SL verified.');return;}
     journal.pause(true);journal.update(row.id,'unknown','Position exists but TP/SL could not be verified. New orders paused; inspect this position in Jupiter.');return;
    }
    journal.update(row.id,'confirmed','Transaction finalized; awaiting Jupiter keeper execution.');return;
   }
   if(result){journal.update(row.id,'submitted','Transaction seen on-chain; awaiting finality.');return;}
   const height=await connection.getBlockHeight('finalized');
   if(height>row.last_height){journal.pause(true);journal.update(row.id,'unknown','Signature not found after expiry. New orders paused; reconcile with an archival RPC before retrying.');return;}
   // Pausing stops fresh broadcasts, but still tracks already-submitted transactions.
   if(closed||journal.paused()||reasons(c).length||expected.owner!==c.vault)return;
   try{const signature=await connection.sendRawTransaction(Buffer.from(row.wire,'base64'),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'});if(signature!==row.signature)fail('RPC returned an unexpected signature.');journal.update(row.id,'submitted','Submitted; awaiting on-chain confirmation and keeper execution.');}catch{journal.update(row.id,'signed','Submission uncertain. Tracking the original signature; retries reuse identical signed bytes.');}
  }catch{
   // Provider errors never mark an ambiguous send as failed or leak secret URLs.
   if(!closed){const row=journal.active();if(row&&row.status!=='preparing')journal.update(row.id,row.status,'Chain verification unavailable. Original order retained; no replacement will be created.');}
  }finally{reconciling=false;}
 }
 async function execute(action,id,internal=false){
  const c=await config();if(action.kind==='pause'){journal.pause(true);return status();}
  if(action.kind==='resume'){const missing=reasons(c);if(missing.length)fail(missing.join(' '));if(cycle().phase==='error')setCycle({...cycle(),phase:cycle().resumePhase||'watching',message:undefined,nextAt:0});journal.pause(false);return status();}
  if(!['open','close','claim',...(internal?['buyback']:[])].includes(action.kind)||!MARKETS.includes(action.market))fail('Choose a supported market and action.');
  const missing=reasons(c);if(missing.length)fail(missing.join(' '));
  if(action.kind!=='close'&&journal.paused())fail('Live orders are paused. Enable them in Admin first.');
  if(action.kind==='open'&&!internal&&cycle().profit&&cycle().phase!=='idle')fail('Manual opens are disabled until the current cycle and buyback settle.');
  const previous=journal.get(id);if(!previous&&action.kind==='open'&&!internal){
   const last=sqlite.prepare("SELECT MAX(created) AS time FROM live_orders WHERE kind='open' AND status<>'failed'").get().time;
   if(last&&Date.now()-last<c.cooldownSeconds*1000)fail('Opening cooldown is still active.');
  }
  const reserved=journal.reserve(id,action);if(reserved.duplicate){void reconcile();return status();}
  try{
   const prepared=await (dependencies.prepare||prepare)(action,c);
   if(closed||fingerprint(await config())!==fingerprint(c)||action.kind!=='close'&&journal.paused())fail('Settings or pause state changed during preparation.');
   const wallet=loadDeveloperWallet(env.DEV_WALLET_PRIVATE_KEY);if(wallet.publicKey.toBase58()!==c.vault)fail('Signing wallet differs from the vault.');
   if(action.kind==='buyback')prepared.expected.cycle=action.cycle;
   prepared.tx.sign([wallet]);
   journal.signed(id,{expected:prepared.expected,wire:Buffer.from(prepared.tx.serialize()).toString('base64'),signature:base58(prepared.tx.signatures[0]),lastHeight:prepared.lastHeight});
  }catch(e){journal.update(id,'failed',safeError(e),'preparing');return status();}
  // A manual protective close is allowed while paused. Submit its persisted bytes once.
  if(action.kind==='close'&&journal.paused()){
   const row=journal.get(id);try{const connection=await verifiedConnection();await connection.sendRawTransaction(Buffer.from(row.wire,'base64'),{skipPreflight:false,maxRetries:0});journal.update(id,'submitted','Close submitted; awaiting keeper execution.');}catch{journal.update(id,'signed','Close submission uncertain; original signature retained. Resume to allow identical-byte retries.');}
  }else await reconcile();
  return status();
 }
 async function advanceCycle(){
  if(cycling||closed||journal.paused()||journal.active())return;cycling=true;
  try{
   const c=await config();if(reasons(c).length)return;let state=cycle();
   if(state.phase==='error')return;
   if(state.owner&&(state.owner!==c.vault||state.mint!==c.tokenMint))fail('Cycle wallet or token changed. Restore the original configuration before settling profit.');
   if(state.phase==='watching'&&state.profit){
    if(await settleProfit(state,c))return;
    state=cycle();
   }
   if(state.phase==='claiming'){
    const claim=journal.get(state.id+'-claim');
    if(claim?.status==='filled'){state={...state,phase:'funding'};setCycle(state);}
    else if(claim?.status==='failed'){journal.pause(true);setCycle({...state,phase:'error',message:claim.message});return;}
    else {await execute({kind:'claim',market:'SOL'},state.id+'-claim',true);return;}
   }
   if(state.phase==='opening'){
    const plan=state.plans[state.index];if(!plan){setCycle({...state,phase:'watching'});return;}
    const id=state.id+'-'+state.index,order=journal.get(id);
    if(order?.status==='filled'||order?.status==='settled'){setCycle({...state,index:state.index+1});return;}
    if(order?.status==='failed'){journal.pause(true);setCycle({...state,phase:'error',resumePhase:'opening',message:order.message});return;}
    await execute({kind:'open',...plan},id,true);return;
   }
   const positions=parsePositions(await api('positions?walletAddress='+encodeURIComponent(c.vault)));
   if(positions.length)return;
   const connection=await verifiedConnection(),accounts=await connection.getMultipleAccountsInfo(MARKETS.map(m=>positionAddress(c.vault,m)),'finalized');
   if(closed||journal.paused()||fingerprint(await config())!==fingerprint(c))return;
   if(accounts.some((account,i)=>chainSize(account,c.vault,MARKETS[i])>0n))return;
   if(state.phase==='watching'){if(state.profit&&state.profit.settled.length<state.plans.length){setCycle({...state,message:'Waiting for finalized close payout receipts before the next cycle.'});return;}setCycle({phase:'idle',nextAt:Date.now()+c.cooldownSeconds*1000});return;}
   if(Date.now()<(state.nextAt||0))return;
   const report=await (dependencies.report?dependencies.report(c):readMainnet(c,env));
   if(closed||journal.paused()||fingerprint(await config())!==fingerprint(c))return;
   if(report.creator!==c.vault||report.rewardsSol===null){journal.pause(true);setCycle({...state,phase:'error',message:'The saved developer wallet must be the token’s verified on-chain fee creator.'});return;}
   if(report.walletSol===null||report.usdc===null||!report.prices.SOL)return;
   const solAvailable=Math.max(0,report.walletSol-0.15),capital=report.usdc+solAvailable*report.prices.SOL+report.rewardsSol*report.prices.SOL;
   if(capital<c.minRewardUsd)return;
   if(state.phase!=='funding'&&report.rewardsSol>0.00001){setCycle({phase:'claiming',id:randomUUID(),nextAt:0});return;}
   // Budget a cycle once. Later markets must not re-allocate an ever-shrinking balance.
   const inputToken=report.usdc>=c.minRewardUsd?'USDC':'SOL',price=inputToken==='SOL'?report.prices.SOL:1,decimals=inputToken==='SOL'?1e9:1e6,available=inputToken==='SOL'?solAvailable*price:report.usdc;
   if(available<c.minRewardUsd)return;
   const plans=MARKETS.filter(m=>c.allocation[m]>0).map(m=>({market:m,inputToken,budget:Math.floor(Math.min(available*c.allocation[m]/100,c.maxPositionUsd/c.leverage)/price*decimals)}));
   if(!plans.length||plans.some(p=>p.budget/decimals*price<10)){journal.pause(true);setCycle({...state,phase:'error',message:'Each enabled market needs at least $10 collateral. Add funds or adjust the strategy.'});return;}
   const principal=Math.ceil(plans.reduce((sum,p)=>sum+p.budget/decimals*price*1e6,0));
   // Reserve all cycle collateral, including still-open legs, plus capped open/close and buyback SOL costs.
   const feeReserve=Math.ceil((plans.length*0.08+0.01)*report.prices.SOL*1e6);
   setCycle({phase:'opening',id:state.id||randomUUID(),owner:c.vault,mint:c.tokenMint,plans,index:0,nextAt:0,profit:{principal:String(principal),feeReserve:String(feeReserve),percent:c.buybackPercent,settled:[],sequence:0}});
  }catch(e){if(!closed){if(e?.safe){journal.pause(true);setCycle({...cycle(),resumePhase:cycle().phase,phase:'error',message:e.message});}else setCycle({...cycle(),message:'Connection checks are unavailable. The cycle will retry without creating a replacement order.'});}}finally{cycling=false;}
 }
 async function settleProfit(state,c){
  const connection=await verifiedConnection(),profit=state.profit;
  // An existing buyback must settle before another amount can be reserved.
  if(profit.order){
   const previous=journal.get(profit.order);
   if(previous?.status==='failed'){journal.pause(true);setCycle({...state,phase:'error',resumePhase:'watching',message:'Buyback failed; profit remains reserved. Resume retries only a definitively failed transaction.'});profit.order=null;setCycle({...cycle(),profit});return true;}
   if(previous&&previous.status!=='filled')return true;
   profit.order=null;if(previous)profit.sequence++;
  }
  for(let index=0;index<state.plans.length;index++){
   if(profit.settled.includes(index))continue;
   const open=journal.get(state.id+'-'+index);if(!open?.expected)continue;
   const expected=JSON.parse(open.expected);
   if(chainSize(await connection.getAccountInfo(new PublicKey(expected.position),'finalized'),c.vault,expected.market)>0n)continue;
   const requests=expected.requests.filter(r=>r.trigger).map(r=>r.address);
   // Include protective manual closes issued by this app for the same cycle position.
   for(const close of sqlite.prepare("SELECT expected FROM live_orders WHERE kind='close' AND created>=? AND expected IS NOT NULL").all(open.created)){
    const e=JSON.parse(close.expected);if(e.owner===c.vault&&e.position===expected.position)requests.push(...e.requests.map(r=>r.address));
   }
   let found=false;
   for(const request of new Set(requests)){
    let before,complete=false;
    for(let page=0;page<10;page++){
     const signatures=await connection.getSignaturesForAddress(new PublicKey(request),{limit:100,...(before?{before}:{})},'finalized');
     for(const signature of signatures){
      if(signature.err)continue;
      if(sqlite.prepare('SELECT 1 FROM close_receipts WHERE signature=? AND request=?').get(signature.signature,request)){found=true;continue;}
      const tx=await connection.getTransaction(signature.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
      if(!tx)throw Error('Historical receipt unavailable');
      const amount=closeReceipt(tx,c.vault,request);
      if(amount>0n){sqlite.prepare('INSERT OR IGNORE INTO close_receipts VALUES(?,?,?,?)').run(signature.signature,request,state.id,String(amount));found=true;}
     }
     if(signatures.length<100){complete=true;break;}before=signatures.at(-1).signature;
    }
    if(!complete)fail('Close receipt history exceeds the supported scan. Reconcile before continuing.');
   }
   if(found)profit.settled.push(index);
  }
  const received=sqlite.prepare('SELECT amount FROM close_receipts WHERE cycle=?').all(state.id).reduce((sum,r)=>sum+BigInt(r.amount),0n);
  const spent=sqlite.prepare("SELECT expected FROM live_orders WHERE kind='buyback' AND status<>'failed' AND expected IS NOT NULL").all().reduce((sum,r)=>{const e=JSON.parse(r.expected);return sum+(e.cycle===state.id?BigInt(e.amount):0n);},0n);
  const amount=buybackBudget(received,profit.principal,profit.feeReserve,profit.percent,spent);
  profit.received=String(received);profit.spent=String(spent);setCycle({...state,profit,message:undefined});
  // Avoid dust orders; retained dust can be used as collateral in the next cycle.
  if(amount<1000000n)return false;
  if(closed||journal.paused()||fingerprint(await config())!==fingerprint(c))return true;
  const id=state.id+'-buyback-'+profit.sequence;
  // A preparation failure has no signature; a failed chain transaction is finalized. Only these allow a new ID.
  if(journal.get(id)?.status==='failed'){profit.sequence++;setCycle({...state,profit});return true;}
  profit.order=id;setCycle({...state,profit,message:'Buying back verified realized profit.'});
  await execute({kind:'buyback',market:'SOL',amount:String(amount),cycle:state.id},id,true);return true;
 }
 const timer=setInterval(()=>void reconcile().then(()=>advanceCycle()),10000);timer.unref();
 return {status,execute,reconcile,advanceCycle,journal,hasUnsettledCycle(){return !!cycle().profit&&cycle().phase!=='idle';},resetCycle(){if(cycle().profit&&cycle().phase!=='idle')fail('Finish the current cycle and buyback before changing setup.');setCycle({phase:'idle',nextAt:0});},close(){closed=true;clearInterval(timer);},safeError};
}
