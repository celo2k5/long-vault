import {isPublicKey} from './address.ts';
export const MARKETS = ['BTC','ETH','SOL'] as const;
export type Market = typeof MARKETS[number];
export type Config = { leverage:number; allocation:Record<Market,number>; minRewardUsd:number; takeProfit:number; stopLoss:number; maxPositionUsd:number; slippageBps:number; collateralSlippageBps?:number; cooldownSeconds:number; buybackPercent:number; treasury:string; vault:string; tokenMint:string; rpcEnv:string; jupiterEnv:string; creator?:string; dataSource?:'mock'|'mainnet' };
export const defaults:Config={leverage:5,allocation:{BTC:40,ETH:30,SOL:30},minRewardUsd:100,takeProfit:100,stopLoss:25,maxPositionUsd:1000,slippageBps:50,cooldownSeconds:120,buybackPercent:75,treasury:'',vault:'',tokenMint:'',rpcEnv:'SOLANA_RPC_URL',jupiterEnv:'JUPITER_API_URL'};
export type Position={market:Market;collateral:number;notional:number;entry:number;mark:number;leverage:number;tp:number;sl:number;liquidation:number;status:'open'|'closed'|'liquidated';pnl:number;roe:number;history:number[];openedAt:number};
export type Event={id:string;time:number;kind:string;detail:string;amount:number;signature:string|null;status:'confirmed'|'failed'};
export type State={config:Config;paused:boolean;pending:number;ready:number;profitReserve:number;realized:number;bought:number;positions:Position[];cycle:number;cyclePnl:number;cycleBuybackPercent:number;cycleActive:boolean;nextCycleAt:number;lastTick:number;events:Event[];processed:Record<string,{fingerprint:string;error?:string}>};
export type Action={type:'tick'|'claim'|'buyback'|'close'|'pause'|'resume'|'configure';market?:Market;config?:Config};
export function initialState(now=Date.now()):State{return {config:structuredClone(defaults),paused:false,pending:24000,ready:0,profitReserve:0,realized:0,bought:0,positions:[],cycle:0,cyclePnl:0,cycleBuybackPercent:75,cycleActive:false,nextCycleAt:now,lastTick:now,events:[],processed:{}};}
const finite=(n:unknown)=>typeof n==='number'&&Number.isFinite(n);
export function validateConfig(c:Config):void {
 if(!c||typeof c!=='object'||!c.allocation)throw Error('Invalid configuration.');
 const ranges:Record<string,[number,number]>={leverage:[1,100],minRewardUsd:[1,1000000],takeProfit:[1,1000],stopLoss:[1,90],maxPositionUsd:[1,1000000],slippageBps:[1,300],cooldownSeconds:[10,86400],buybackPercent:[0,100]};
 for(const [key,[lo,hi]] of Object.entries(ranges)){const n=c[key as keyof Config];if(!finite(n)||(n as number)<lo||(n as number)>hi)throw Error(key+' must be between '+lo+' and '+hi+'.');}
 if(c.collateralSlippageBps!==undefined&&(!Number.isInteger(c.collateralSlippageBps)||c.collateralSlippageBps<1||c.collateralSlippageBps>1000))throw Error('Collateral swap slippage must be 1–1000 whole basis points.');
 if(!Number.isInteger(c.slippageBps)||!Number.isInteger(c.cooldownSeconds))throw Error('Slippage and cooldown must be whole numbers.');
 if(MARKETS.some(m=>!finite(c.allocation[m])||c.allocation[m]<0||c.allocation[m]>100)||Math.abs(MARKETS.reduce((n,m)=>n+c.allocation[m],0)-100)>0.000001)throw Error('BTC, ETH and SOL allocations must total 100%.');
 for(const key of ['treasury','vault','tokenMint'] as const)if(typeof c[key]!=='string'||(c[key]&&!isPublicKey(c[key])))throw Error(key+' must be a 32-byte Solana public address.');
 if(c.creator!==undefined&&c.creator!==''&&!isPublicKey(c.creator))throw Error('Creator must be a Solana public address.');
 if(c.dataSource!==undefined&&!['mock','mainnet'].includes(c.dataSource))throw Error('Invalid data source.');
 if(c.rpcEnv!=='SOLANA_RPC_URL'||c.jupiterEnv!=='JUPITER_API_URL')throw Error('Use the approved server environment references. Never paste secrets into settings.');
}
export function mockMarks(now:number):Record<Market,number>{const t=now/60000;return {BTC:Math.round(84000*(1+.022*Math.sin(t*.8))),ETH:Math.round(2800*(1+.026*Math.sin(t*.67+1))*100)/100,SOL:Math.round(145*(1+.035*Math.sin(t*.9+2))*100)/100};}
function event(s:State,now:number,kind:string,detail:string,amount=0,failed=false){s.events.unshift({id:crypto.randomUUID(),time:now,kind,detail,amount,signature:failed?null:'mock:'+crypto.randomUUID(),status:failed?'failed':'confirmed'});}
function claim(s:State,now:number){if(s.paused)throw Error('Vault paused. Claiming is disabled.');if(s.pending<=0)throw Error('No pending rewards.');const amount=s.pending;s.ready+=amount;s.pending=0;event(s,now,'Claim','Creator rewards moved to deployable balance',amount);}
function buyback(s:State,now:number){if(s.paused)throw Error('Vault paused. Buybacks are disabled.');if(s.profitReserve<=0)throw Error('No realized profit reserved for buyback.');const amount=s.profitReserve;s.bought+=amount;s.profitReserve=0;event(s,now,'Buyback','Simulated main-token purchase; no on-chain fill',amount);}
function finishCycle(s:State,now:number){if(!s.cycleActive||s.positions.some(p=>p.status==='open'))return;const reserve=Math.min(s.ready,Math.floor(Math.max(0,s.cyclePnl)*s.cycleBuybackPercent/100));s.ready-=reserve;s.profitReserve+=reserve;s.nextCycleAt=now+s.config.cooldownSeconds*1000;s.cycleActive=false;event(s,now,'Cycle','Cycle '+s.cycle+' settled; net realized PnL',s.cyclePnl);}
function close(s:State,p:Position,now:number,reason:string){if(p.status!=='open')return;const liquidation=p.mark<=p.liquidation;const closeFee=liquidation?0:Math.ceil(p.notional*.0006);const net=liquidation?-p.collateral:Math.max(-p.collateral,p.pnl-closeFee);p.pnl=net;p.roe=net/p.collateral*100;p.status=liquidation?'liquidated':'closed';s.ready+=Math.max(0,p.collateral+net);s.realized+=net;s.cyclePnl+=net;event(s,now,liquidation?'Liquidation':'Close',p.market+' · '+reason,net);finishCycle(s,now);}
function marks(s:State,prices:Record<Market,number>){for(const p of s.positions.filter(p=>p.status==='open')){p.mark=prices[p.market];p.pnl=Math.round(p.notional*(p.mark/p.entry-1));p.roe=p.pnl/p.collateral*100;p.history=[...p.history,p.mark].slice(-40);}}
function open(s:State,now:number,prices:Record<Market,number>){if(s.paused||s.cycleActive||now<s.nextCycleAt||s.ready<Math.round(s.config.minRewardUsd*100))return;
 const available=s.ready;const plans=MARKETS.map(m=>{const cap=Math.floor(s.config.maxPositionUsd*100/s.config.leverage);const collateral=Math.min(cap,Math.floor(available*s.config.allocation[m]/100/(1+s.config.leverage*.0006)));return {m,collateral,notional:Math.floor(collateral*s.config.leverage)};}).filter(p=>p.collateral>=100);
 const spend=plans.reduce((n,p)=>n+p.collateral+Math.ceil(p.notional*.0006),0);if(!plans.length||spend>available)throw Error('Insufficient balance after simulated opening fees. Lower position size or claim more rewards.');
 s.cycle++;s.cycleActive=true;s.cyclePnl=0;s.cycleBuybackPercent=s.config.buybackPercent;s.positions=[];
 for(const p of plans){const fee=Math.ceil(p.notional*.0006);s.ready-=p.collateral+fee;s.realized-=fee;s.cyclePnl-=fee;const entry=prices[p.m];s.positions.push({market:p.m,collateral:p.collateral,notional:p.notional,entry,mark:entry,leverage:s.config.leverage,tp:s.config.takeProfit,sl:s.config.stopLoss,liquidation:entry*(1-1/s.config.leverage+.005),status:'open',pnl:0,roe:0,history:[entry],openedAt:now});event(s,now,'Open',p.m+' '+s.config.leverage+'x long · simulated',p.notional);}
}
export function transition(input:State,action:Action,id:string,now=Date.now(),prices=mockMarks(now)):{state:State;error?:string;duplicate?:boolean}{
 if(!/^[a-zA-Z0-9:_-]{8,120}$/.test(id))throw Error('Invalid idempotency key.');
 const fingerprint=JSON.stringify(action);if(input.processed[id]){if(input.processed[id].fingerprint!==fingerprint)throw Error('Idempotency key already used for a different command.');return {state:input,error:input.processed[id].error,duplicate:true};}
 let s=structuredClone(input);let error:string|undefined;
 try{
 validateConfig(s.config);
 if(s.config.dataSource==='mainnet'&&!['configure','pause','resume'].includes(action.type))throw Error('Mainnet monitoring is read-only. No signing authority or live execution is enabled.');
 if(MARKETS.some(m=>!finite(prices[m])||prices[m]<=0))throw Error('Invalid mark prices. No action taken.');
 if(!finite(now)||now<input.lastTick)throw Error('Clock moved backwards.');
 if(action.type==='pause'){s.paused=true;event(s,now,'Pause','Claims, opens and buybacks paused; protective closes remain enabled');}
 else if(action.type==='resume'){s.paused=false;event(s,now,'Resume','Automation resumed');}
 else if(action.type==='configure'){validateConfig(action.config!);s.config=structuredClone(action.config!);event(s,now,'Config','Configuration updated; existing positions retain TP/SL and leverage');}
 else {marks(s,prices);
 if(action.type==='claim')claim(s,now);
 else if(action.type==='buyback')buyback(s,now);
 else if(action.type==='close'){const positions=s.positions.filter(p=>p.status==='open'&&(!action.market||p.market===action.market));if(!positions.length)throw Error('No matching open positions.');for(const p of positions)close(s,p,now,'Manual close');}
 else if(action.type==='tick'){
 s.pending+=Math.floor(Math.min(60,(now-s.lastTick)/1000));s.lastTick=now;
 for(const p of s.positions.filter(p=>p.status==='open'))if(p.mark<=p.liquidation||p.roe>=p.tp||p.roe<=-p.sl)close(s,p,now,p.mark<=p.liquidation?'Liquidated':p.roe>=p.tp?'Take profit':'Stop loss');
 if(!s.paused){if(s.profitReserve>0)buyback(s,now);if(s.pending>=Math.round(s.config.minRewardUsd*100))claim(s,now);open(s,now,prices);}
 }else throw Error('Unknown command.');
 }
 if([s.pending,s.ready,s.profitReserve,s.bought].some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Balance invariant violated.');
 }catch(e){error=e instanceof Error?e.message:'Action failed';s=structuredClone(input);event(s,now,'Failure',error,0,true);}
 s.processed[id]={fingerprint,...(error?{error}:{})};return {state:s,error};
}


