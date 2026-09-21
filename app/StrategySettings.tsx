"use client";
import {useState} from 'react';
import {toast} from 'sonner';
import {type Config,validateConfig} from '@/lib/engine';
type Strategy=Pick<Config,'leverage'|'allocation'|'minRewardUsd'|'takeProfit'|'stopLoss'|'maxPositionUsd'|'slippageBps'|'buybackPercent'>;
const pick=(c:Config):Strategy=>({leverage:c.leverage,allocation:{...c.allocation},minRewardUsd:c.minRewardUsd,takeProfit:c.takeProfit,stopLoss:c.stopLoss,maxPositionUsd:c.maxPositionUsd,slippageBps:c.slippageBps,buybackPercent:c.buybackPercent});
const fields=[['leverage','Leverage (×)',1,100],['minRewardUsd','Minimum cycle capital ($)',1,1000000],['takeProfit','Take profit (% ROE)',1,1000],['stopLoss','Stop loss (% ROE)',1,90],['maxPositionUsd','Maximum position notional ($)',1,1000000],['slippageBps','Slippage (basis points)',1,300],['buybackPercent','Profit used for buybacks (%)',0,100]] as const;
export function StrategySettings({config,enabled,onSaved}:{config:Config;enabled:boolean;onSaved:()=>Promise<void>}){
 const [draft,setDraft]=useState<Strategy>(()=>pick(config)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const total=Object.values(draft.allocation).reduce((sum,n)=>sum+n,0);
 async function save(){if(busy)return;setError('');try{validateConfig({...config,...draft});}catch(e){setError(e instanceof Error?e.message:'Invalid strategy');return;}setBusy(true);
  try{const response=await fetch('/api/strategy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)});const result=await response.json() as {error?:string;config:Config};if(!response.ok)throw Error(result.error||'Strategy could not be saved.');setDraft(pick(result.config));await onSaved();toast.success('Strategy saved. Start cycles when ready.');}catch(e){setError(e instanceof Error?e.message:'Strategy save failed.');}finally{setBusy(false);}
 }
 return <details className="panel settings-section"><summary>Strategy <small> · {config.leverage}× · {config.buybackPercent}% buyback</small></summary><form onSubmit={e=>{e.preventDefault();void save();}}>
 <p>Adjust the next cycle. Saving pauses automation; active cycles must finish first.</p><fieldset disabled={busy||!enabled} style={{border:0,padding:0,margin:0}}><div className="field-grid">{fields.map(([key,label,min,max])=><label key={key}>{label}<input required type="number" min={min} max={max} step={key==='slippageBps'?1:'any'} value={Number.isFinite(draft[key])?draft[key]:''} onChange={e=>setDraft({...draft,[key]:e.target.value===''?NaN:Number(e.target.value)})}/></label>)}</div>
 <p>Allocation · {Number.isFinite(total)?total:'—'}% / 100%</p><div className="field-grid">{(['BTC','ETH','SOL'] as const).map(m=><label key={m}>{m} (%)<input required type="number" min={0} max={100} step="any" value={Number.isFinite(draft.allocation[m])?draft.allocation[m]:''} onChange={e=>setDraft({...draft,allocation:{...draft.allocation,[m]:e.target.value===''?NaN:Number(e.target.value)}})}/></label>)}</div>
 <p className="risk-note">Higher leverage brings liquidation closer. TP and SL are ROE targets; fees and execution affect the final return. 100 basis points = 1% slippage.</p>{error&&<p role="alert" className="negative">{error}</p>}<div className="actions"><button className="primary" disabled={!Number.isFinite(total)||Math.abs(total-100)>0.000001}>{busy?'Saving…':'Save strategy'}</button><button className="secondary" type="button" onClick={()=>{setDraft(pick(config));setError('');}}>Reset changes</button></div></fieldset></form></details>;
}
