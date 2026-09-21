"use client";
import {useEffect,useState} from 'react';
import {PositionCards} from './PositionCards';
import type {MainnetReport,Preview} from '@/lib/mainnet';
import {MARKETS,type Config,type Market} from '@/lib/engine';

export function useConnections(enabled:boolean,config:Config){
 const [report,setReport]=useState<MainnetReport|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[history,setHistory]=useState<Partial<Record<Market,number[]>>>({});
 const settings=JSON.stringify(config);
 useEffect(()=>{if(!enabled)return;let active=true;const controller=new AbortController();setReport(null);setHistory({});
  const read=async()=>{setLoading(true);try{const response=await fetch('/api/connections',{cache:'no-store',signal:controller.signal});const value=await response.json() as MainnetReport & {error?:string};if(!response.ok)throw Error(value.error||'Connection checks unavailable');if(active){setReport(value);setError('');setHistory(previous=>Object.fromEntries(MARKETS.map(m=>[m,Number.isFinite(value.prices[m])?[...(previous[m]||[]),value.prices[m]!].slice(-40):previous[m]||[]])));}}catch(e){if(active)setError(e instanceof Error?e.message:'Connection checks unavailable');}finally{if(active)setLoading(false);}};
  void read();const timer=setInterval(()=>void read(),30000);return()=>{active=false;controller.abort();clearInterval(timer);};
 },[enabled,settings]);
 return {report,error,loading,history};
}
export function Connections({config}:{config:Config}){
 const {report,error,loading}=useConnections(true,config),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[failure,setFailure]=useState('');
 useEffect(()=>{setPreview(null);setFailure('');},[JSON.stringify(config)]);
 async function run(kind:'claim'|'open',market?:Market){setBusy(true);setFailure('');setPreview(null);try{const response=await fetch('/api/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,market})});const value=await response.json() as Preview & {error?:string};if(!response.ok)throw Error(value.error||'Preview unavailable');setPreview(value);}catch(e){setFailure(e instanceof Error?e.message:'Preview unavailable');}finally{setBusy(false);}}
 return <section className="panel settings-section"><h2>Mainnet connections</h2><p>Uses saved public addresses. Checks refresh every 30 seconds. Previews simulate unsigned transactions and cannot move funds.</p>{error&&<p role="alert" className="negative">{error}</p>}{!report&&loading&&<p>Checking connections…</p>}
 <div className="connection-checks">{report?.checks.map(check=><div key={check.name}><span className={check.status==='ok'?'positive':check.status==='error'?'negative':''}>{check.status==='ok'?'✓':'○'} {check.name}</span><small>{check.detail}</small></div>)}</div>
 {report?.creator&&<p className="admin-note">On-chain creator: <code>{report.creator}</code></p>}
 <div className="actions"><button type="button" className="secondary" disabled={busy||!report} onClick={()=>run('claim')}>Preview claim</button>{MARKETS.map(m=><button key={m} type="button" className="secondary" disabled={busy||!report} onClick={()=>run('open',m)}>Preview {m} long</button>)}</div>
 {busy&&<p role="status">Simulating against mainnet…</p>}{failure&&<p role="alert" className="negative">{failure}</p>}{preview&&<div role="status" className="preview-result"><p>{preview.message}</p>{preview.entry&&<p>Entry ${preview.entry.toFixed(2)} · Est. liquidation ${preview.liquidation?.toFixed(2)} · {preview.leverage}× · Notional ${preview.notionalUsd?.toFixed(2)} · Opening fee ${preview.openFeeUsd?.toFixed(2)}</p>}<small>{new Date(preview.simulatedAt).toLocaleString()} · Compute units: {preview.unitsConsumed??'unavailable'}</small></div>}
 </section>;
}
const money=(n:number|null|undefined)=>n===null||n===undefined?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);
export function MainnetOverview({config,copy}:{config:Config;copy:(s:string)=>void}){
 const {report:received,error,history}=useConnections(true,config);
 const [clock,setClock]=useState(Date.now());useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),5000);return()=>clearInterval(timer);},[]);
 const stale=!!received&&clock-received.checkedAt>60000;
 const report=stale||error?null:received;
 const positions=report?.positions,notional=positions?.reduce((total,p)=>total+p.notionalUsd,0);
 return <div className="overview-content">{error&&<p role="alert" className="negative">{error} · Last known values may be stale.</p>}{stale&&<p role="alert" className="negative">Live data is stale. Check the server connection.</p>}
 <div className="stats"><section className="panel"><label>Automation</label><strong>{!config.vault?'Not configured':positions?'Monitoring':'Unavailable'}</strong><small>Trading not enabled</small></section><section className="panel"><label>Open notional</label><strong>{money(notional)}</strong><small>Jupiter · {report?new Date(report.checkedAt).toLocaleTimeString():'Connecting'}</small></section><section className="panel"><label>$LONG CA</label><strong className="contract-value">{config.tokenMint?config.tokenMint.slice(0,5)+'…'+config.tokenMint.slice(-5):'Not configured'}</strong>{config.tokenMint&&<><button className="text-button" onClick={()=>copy(config.tokenMint)}>Copy contract</button><a className="text-button" href={'https://solscan.io/token/'+config.tokenMint} target="_blank" rel="noreferrer">View token ↗</a></>}</section></div>
 <div className="section-title"><h2>Vault balance</h2><span>Solana mainnet · read only</span></div><div className="pipeline"><section><label>Unclaimed creator fees</label><strong>{report?.rewardsSol===null||!report?'—':report.rewardsSol.toFixed(4)+' SOL'}</strong><small>wallet-wide · not $LONG-only</small></section><section><label>USDC balance</label><strong>{money(report?.usdc)}</strong><small>vault wallet · USDC</small></section><section><label>Vault SOL</label><strong>{report?.walletSol===null||!report?'—':report.walletSol.toFixed(4)+' SOL'}</strong><small>wallet balance · not claimed fees</small></section><section><label>Unrealized PnL</label><strong>{money(positions?.reduce((total,p)=>total+p.pnlUsd,0))}</strong><small>Jupiter · after reported fees</small></section></div>
 <div className="section-title"><h2>Positions</h2><span>Live prices &amp; protocol liquidation estimates</span></div><PositionCards leverage={config.leverage} unavailable={!positions} prices={report?.prices} positions={(positions||[]).map(p=>({market:p.market,side:p.side,collateralUsd:p.collateralUsd,notionalUsd:p.notionalUsd,mark:p.mark,liquidation:p.liquidation,leverage:p.leverage,pnlUsd:p.pnlUsd,roe:p.roe,progress:p.takeProfitPrice?(p.mark-p.entry)/(p.takeProfitPrice-p.entry)*100:null,history:history[p.market]||[],status:'open',note:(positions||[]).filter(other=>other.market===p.market).length>1?'Multiple positions · view Jupiter':!p.stopLossPrice?'No stop loss':undefined}))}/><p className="risk-note">Leveraged positions can lose all collateral. Liquidation estimates change with prices and fees. Monitoring does not manage or close positions.</p></div>;
}
