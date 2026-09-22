// Server-only integration. Reads and unsigned simulation; deliberately no signer or send method.
import {Connection,PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
// The pinned SDK ESM entry imports a CJS-only Anchor named export. Use its CJS build.
import pumpSdk from '../node_modules/@pump-fun/pump-sdk/dist/index.js';
const {OnlinePumpSdk,hasCoinCreatorMigratedToSharingConfig}=pumpSdk;
import {z} from 'zod';
import {MARKETS,validateConfig,type Config,type Market} from './engine.ts';
import {developerWalletStatus} from './dev-wallet.ts';
import {isPublicKey} from './address.ts';

export type LiveEnvironment={DEV_WALLET_PRIVATE_KEY?:string;SOLANA_RPC_URL?:string;JUPITER_API_URL?:string;JUPITER_API_KEY?:string};
export const MINTS={SOL:'So11111111111111111111111111111111111111112',BTC:'3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',ETH:'7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',USDC:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'};
export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const key=z.string().refine(isPublicKey,'Invalid public key');
const integer=z.string().regex(/^-?\d+$/).refine(v=>Number.isSafeInteger(Number(v)),'Amount exceeds supported precision');
const numeric=z.union([z.string().min(1),z.number()]).transform(Number).refine(Number.isFinite);
const positive=numeric.refine(v=>v>0);
const positionSchema=z.object({positionPubkey:key,asset:z.enum(['BTC','ETH','SOL']),side:z.enum(['long','short']),leverage:positive,sizeUsd:integer,collateralUsd:integer,entryPriceUsd:integer,markPriceUsd:integer,liquidationPriceUsd:integer,pnlAfterFeesUsd:integer,pnlAfterFeesPct:numeric,tpslRequests:z.array(z.object({requestType:z.enum(['tp','sl']),triggerPriceUsd:integer.nullable()}))});
export type ChainPosition={address:string;market:Market;side:'long'|'short';leverage:number;notionalUsd:number;collateralUsd:number;entry:number;mark:number;liquidation:number;pnlUsd:number;roe:number;takeProfitPrice:number|null;stopLossPrice:number|null};
export type Check={name:string;status:'ok'|'missing'|'error'|'blocked';detail:string};
export type MainnetReport={checkedAt:number;checks:Check[];executionEnabled:false;creator:string|null;rewardsSol:number|null;walletSol:number|null;usdc:number|null;positions:ChainPosition[]|null;prices:Partial<Record<Market,number>>};
const micro=(s:string)=>Number(s)/1e6;
export function parsePositions(raw:unknown):ChainPosition[]{
 const response=z.object({count:z.number().int().nonnegative(),dataList:z.array(positionSchema).max(100)}).parse(raw);
 if(response.count!==response.dataList.length)throw Error('Incomplete Jupiter positions response');
 return response.dataList.map(p=>{
  if([p.sizeUsd,p.collateralUsd,p.entryPriceUsd,p.markPriceUsd,p.liquidationPriceUsd].some(v=>Number(v)<=0))throw Error('Invalid Jupiter position values');
  return {address:p.positionPubkey,market:p.asset,side:p.side,leverage:p.leverage,notionalUsd:micro(p.sizeUsd),collateralUsd:micro(p.collateralUsd),entry:micro(p.entryPriceUsd),mark:micro(p.markPriceUsd),liquidation:micro(p.liquidationPriceUsd),pnlUsd:micro(p.pnlAfterFeesUsd),roe:p.pnlAfterFeesPct,takeProfitPrice:p.tpslRequests.find(t=>t.requestType==='tp')?.triggerPriceUsd?micro(p.tpslRequests.find(t=>t.requestType==='tp')!.triggerPriceUsd!):null,stopLossPrice:p.tpslRequests.find(t=>t.requestType==='sl')?.triggerPriceUsd?micro(p.tpslRequests.find(t=>t.requestType==='sl')!.triggerPriceUsd!):null};
 });
}
export function perpsBase(env:LiveEnvironment){const u=env.JUPITER_API_URL||'https://perps-api.jup.ag/v2';if(u!=='https://perps-api.jup.ag/v2')throw Error('JUPITER_API_URL must be the official https://perps-api.jup.ag/v2 endpoint');return u;}
export async function boundedFetch(input:RequestInfo|URL,init:RequestInit={},fetcher:typeof fetch=fetch,maxAttempts=3):Promise<Response>{
 // Retry only reads or unsigned construction, never signing or broadcasting.
 for(let attempt=0;attempt<maxAttempts;attempt++){
  try{const response=await fetcher(input,{...init,redirect:'error',signal:AbortSignal.timeout(12000)});
   if((response.status===429||response.status>=500)&&attempt<maxAttempts-1){await response.body?.cancel();await new Promise(r=>setTimeout(r,200*(attempt+1)));continue;}
   if(!response.ok){await response.body?.cancel();throw Error('Upstream service returned HTTP '+response.status);}
   return response;
  }catch(e){if(attempt===maxAttempts-1||e instanceof Error&&e.message.startsWith('Upstream'))throw Error(e instanceof Error&&e.message.startsWith('Upstream')?e.message:'Network request failed or timed out');}
 }throw Error('Network request failed');
}
async function json(response:Response){const reader=response.body?.getReader();if(!reader)throw Error('Empty service response');let text='',bytes=0;const decoder=new TextDecoder();try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>2_000_000)throw Error('Oversized service response');text+=decoder.decode(r.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}finally{await reader.cancel();}}
export function rpcConnection(env:LiveEnvironment){
 if(!env.SOLANA_RPC_URL)throw Error('Set SOLANA_RPC_URL in server secrets');
 const url=new URL(env.SOLANA_RPC_URL);
 if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error('RPC requires an HTTPS URL without user information or fragment');
 return new Connection(url.toString(),{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(input,init)=>boundedFetch(input,init)});
}
export async function jupiter(env:LiveEnvironment,path:string,body?:unknown){
 const response=await boundedFetch(perpsBase(env)+'/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-client-platform':'long-vault',...(env.JUPITER_API_KEY?{'x-api-key':env.JUPITER_API_KEY}:{})},...(body?{body:JSON.stringify(body)}:{})},fetch,path==='transaction/execute'?1:3);
 return json(response);
}
export async function confirmedMainnet(connection:Connection){if(await connection.getGenesisHash()!==MAINNET_GENESIS)throw Error('RPC is not Solana mainnet; Jupiter perpetuals require mainnet');}
export async function readMainnet(config:Config,env:LiveEnvironment):Promise<MainnetReport>{
 validateConfig(config);
 const r:MainnetReport={checkedAt:Date.now(),checks:[],executionEnabled:false,creator:null,rewardsSol:null,walletSol:null,usdc:null,positions:null,prices:{}};
 const check=async(name:string,run:()=>Promise<string>)=>{try{r.checks.push({name,status:'ok',detail:await run()});}catch(e){r.checks.push({name,status:'error',detail:e instanceof z.ZodError?'Service returned an invalid response':e instanceof Error?e.message:'Check failed'});}};
 // Do not return raw RPC exception messages: providers may include credentials in URLs.
 let connection:Connection|undefined;
 await check('Solana RPC',async()=>{connection=rpcConnection(env);try{await confirmedMainnet(connection);}catch{connection=undefined;throw Error('Could not verify a mainnet RPC connection');}return 'Mainnet connection verified';});
 await Promise.all([
 check('Jupiter markets',async()=>{const prices=await Promise.all(MARKETS.map(async m=>{const raw=await jupiter(env,'market-stats?mint='+MINTS[m]);const value=z.object({price:positive}).parse(raw);return [m,value.price] as const;}));r.prices=Object.fromEntries(prices);return 'BTC, ETH and SOL market prices received';}),
 config.vault?check('Vault balances',async()=>{if(!connection)throw Error('RPC unavailable');try{const wallet=new PublicKey(config.vault);if(!PublicKey.isOnCurve(wallet.toBytes()))throw Error('Vault authority needs a supported signer');const [balance,tokens]=await Promise.all([connection.getBalance(wallet),connection.getParsedTokenAccountsByOwner(wallet,{mint:new PublicKey(MINTS.USDC)})]);let amount=BigInt(0);for(const a of tokens.value){const info=a.account.data.parsed.info;if(info.mint!==MINTS.USDC||info.owner!==config.vault||info.tokenAmount.decimals!==6||!/^\d+$/.test(info.tokenAmount.amount))throw Error('Invalid token account');amount+=BigInt(info.tokenAmount.amount);}if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Balance too large');r.walletSol=balance/1e9;r.usdc=Number(amount)/1e6;return 'SOL and USDC balances verified';}catch{throw Error('Could not verify vault balances or wallet authority');}}):Promise.resolve(r.checks.push({name:'Vault balances',status:'missing',detail:'Save the public vault wallet in Admin'})),
 config.vault?check('Jupiter positions',async()=>{r.positions=parsePositions(await jupiter(env,'positions?walletAddress='+encodeURIComponent(config.vault)));return r.positions.length+' live positions found';}):Promise.resolve(r.checks.push({name:'Jupiter positions',status:'missing',detail:'Save a vault wallet to read positions'})),
 config.tokenMint?check('Pump creator rewards',async()=>{if(!connection)throw Error('RPC unavailable');const sdk=new OnlinePumpSdk(connection);let curve;try{curve=await sdk.fetchBondingCurve(new PublicKey(config.tokenMint));}catch{throw Error('CA is not a readable Pump bonding curve on this RPC');}
  r.creator=curve.creator.toBase58();
  if(curve.isHolderReward)throw Error('Holder-reward coins do not pay fees to a creator wallet');
  if(hasCoinCreatorMigratedToSharingConfig({mint:new PublicKey(config.tokenMint),creator:curve.creator}))throw Error('Shared creator fees require a separate distribution integration');
  if(config.creator&&config.creator!==r.creator)throw Error('Configured creator does not match the on-chain creator');
  if(![PublicKey.default.toBase58(),MINTS.SOL].includes(curve.quoteMint.toBase58()))throw Error('This integration currently supports SOL-paired creator fees only');
  try{const balance=await sdk.getCreatorVaultBalanceBothPrograms(curve.creator);r.rewardsSol=balance.toNumber()/1e9;}catch{throw Error('Could not read creator fee vaults');}
  return 'Creator discovered from CA; rewards include all coins sharing this creator wallet';
 }):Promise.resolve(r.checks.push({name:'Pump creator rewards',status:'missing',detail:'Save the $LONG CA to discover its creator'}))
 ]);
 if(config.vault&&r.creator&&config.vault!==r.creator)r.checks.push({name:'Reward routing',status:'blocked',detail:'Fees pay the creator wallet. A different vault requires an authorized transfer from that creator.'});
 if(r.positions?.some(p=>p.side!=='long'||!p.stopLossPrice||!p.takeProfitPrice))r.checks.push({name:'Position protection',status:'blocked',detail:'Existing positions include a short or a missing on-chain TP/SL. Review in Jupiter.'});
 r.checks.push({name:'Automated execution',status:'blocked',detail:'Use Live positions in Admin for trading status. Connection checks and previews cannot move funds; the separate cycle worker handles execution.'});
 r.checkedAt=Date.now();return r;
}

export type Preview={kind:'claim'|'open';market?:Market;simulatedAt:number;entry?:number;liquidation?:number;leverage?:number;notionalUsd?:number;openFeeUsd?:number;unitsConsumed:number|null;message:string};
async function simulate(connection:Connection,tx:VersionedTransaction,owner:string){
 const required=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures);
 if(tx.message.staticAccountKeys[0]?.toBase58()!==owner||required.length!==1||required[0].toBase58()!==owner)throw Error('Unexpected transaction fee payer or required signer');
 if(tx.signatures.some(sig=>sig.some(byte=>byte!==0)))throw Error('Expected an unsigned transaction');
 try{const result=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed'});if(result.value.err)throw Error('Simulation failed');return result.value.unitsConsumed??null;}catch{throw Error('RPC simulation failed. Check wallet funding, account setup and protocol limits.');}
}
export async function previewMainnet(config:Config,env:LiveEnvironment,kind:'claim'|'open',market:Market='SOL'):Promise<Preview>{
 validateConfig(config);if(!config.vault)throw Error('Save a vault wallet first');
 const report=await readMainnet(config,env);
 if(env.DEV_WALLET_PRIVATE_KEY){const wallet=developerWalletStatus(env.DEV_WALLET_PRIVATE_KEY,config.vault,report.creator||undefined);if(wallet.status!=='configured')throw Error(wallet.message);}
 if(report.checks.some(c=>c.status==='error'||c.status==='missing'))throw Error('Resolve the connection checks before requesting a preview');
 if(report.walletSol===null||report.walletSol<0.01)throw Error('Vault needs at least 0.01 SOL for fees before simulation');
 const connection=rpcConnection(env);let tx:VersionedTransaction;
 if(kind==='claim'){
  if(!report.creator||report.creator!==config.vault)throw Error('Claim preview requires the creator and vault to be the same wallet');
  if(!report.rewardsSol||report.rewardsSol<=0)throw Error('No SOL creator rewards to claim');
  const sdk=new OnlinePumpSdk(connection);const instructions=await sdk.collectCoinCreatorFeeInstructions(new PublicKey(report.creator),new PublicKey(config.vault));
  const {blockhash}=await connection.getLatestBlockhash();tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(config.vault),recentBlockhash:blockhash,instructions}).compileToV0Message());
  return {kind,simulatedAt:Date.now(),unitsConsumed:await simulate(connection,tx,config.vault),message:'Pump claim simulated against mainnet. No transaction was signed or sent.'};
 }
 if(!MARKETS.includes(market))throw Error('Unsupported market');
 if(!report.positions||report.positions.length)throw Error('Preview requires a vault with no existing Jupiter positions');
 if(report.usdc===null||report.usdc<config.minRewardUsd)throw Error('USDC balance is below the configured cycle threshold');
 const collateral=Math.floor(Math.min(report.usdc*config.allocation[market]/100,config.maxPositionUsd/config.leverage)*1e6)/1e6;
 if(collateral<10)throw Error('Jupiter requires at least $10 collateral per new position');
 const mark=report.prices[market];if(!mark)throw Error('Market price unavailable');
 const raw=await jupiter(env,'positions/increase',{asset:market,inputToken:'USDC',inputTokenAmount:String(Math.floor(collateral*1e6)),side:'long',maxSlippageBps:String(config.slippageBps),leverage:String(config.leverage),walletAddress:config.vault,tpsl:[{receiveToken:'USDC',triggerPrice:String(Math.round(mark*(1+config.takeProfit/100/config.leverage)*1e6)),requestType:'tp'},{receiveToken:'USDC',triggerPrice:String(Math.round(mark*(1-config.stopLoss/100/config.leverage)*1e6)),requestType:'sl'}]});
 const q=z.object({serializedTxBase64:z.string().min(80).max(20000),positionPubkey:key,quote:z.object({side:z.literal('long'),averagePriceUsd:integer,liquidationPriceUsd:integer,leverage:positive,sizeUsdDelta:integer,openFeeUsd:integer}),txMetadata:z.object({lastValidBlockHeight:integer})}).parse(raw);
 const entry=micro(q.quote.averagePriceUsd),liquidation=micro(q.quote.liquidationPriceUsd),notional=micro(q.quote.sizeUsdDelta);
 if(entry<=0||liquidation<=0||liquidation>=entry||notional<=0||notional>config.maxPositionUsd||q.quote.leverage>config.leverage*1.01||Math.abs(entry/mark-1)*10000>config.slippageBps)throw Error('Jupiter quote exceeds configured risk limits');
 if(await connection.getBlockHeight()>Number(q.txMetadata.lastValidBlockHeight))throw Error('Quote transaction expired');
 tx=VersionedTransaction.deserialize(Buffer.from(q.serializedTxBase64,'base64'));
 return {kind,market,entry,liquidation,leverage:q.quote.leverage,notionalUsd:notional,openFeeUsd:micro(q.quote.openFeeUsd),unitsConsumed:await simulate(connection,tx,config.vault),simulatedAt:Date.now(),message:'Unsigned Jupiter order simulated only. TP/SL prices approximate configured ROE before costs. This does not validate every instruction for signing.'};
}
