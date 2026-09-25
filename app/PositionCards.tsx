"use client";
import {MARKETS,type Market} from '@/lib/engine';

export type CardPosition={market:Market;side?:'long'|'short';collateralUsd:number;notionalUsd:number;mark:number;liquidation:number;leverage:number;pnlUsd:number;roe:number;progress:number|null;history:number[];status:'open'|'closed'|'liquidated';note?:string};
const currency=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);
const markPrice=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:n>=10000?'compact':'standard',maximumFractionDigits:2}).format(n);
const names={BTC:'Bitcoin',ETH:'Ethereum',SOL:'Solana'};
export function PositionCards({positions,leverage,unavailable=false,prices={}}:{positions:CardPosition[];leverage:number;unavailable?:boolean;prices?:Partial<Record<Market,number>>}){
 return <div className="positions sleek-positions">{MARKETS.map(market=>{
  const p=positions.find(p=>p.market===market);const loss=!!p&&p.pnlUsd<0;const active=p?.status==='open';const values=(p?.history||[]).filter(Number.isFinite);const min=Math.min(...values),max=Math.max(...values);const points=values.map((v,i)=>(i/(values.length-1||1)*220).toFixed(2)+','+(max===min?22:40-(v-min)/(max-min)*34).toFixed(2)).join(' ');const progress=p?.progress===null||!p||!Number.isFinite(p.progress)?null:Math.min(100,Math.max(0,p.progress));const distance=p?Math.abs(p.mark-p.liquidation)/p.mark*100:0;
  return <article className={'position sleek-position '+(loss?'losing':p&&p.pnlUsd>0?'winning':'neutral')} key={market} aria-label={market+' position'}>
   <div className="position-head"><div className="market-identity"><img src={'/coins/'+(market==='SOL'?'solana':market.toLowerCase())+'.svg'} alt={names[market]+' logo'} width="30" height="30"/><div><h3>{market}</h3><span>{names[market]}{p?.side==='short'?' · Short':''}</span></div></div><b className="badge">{p?Number(p.leverage.toFixed(1))+'×':'—'}</b></div>
   <div className={'pnl '+(loss?'negative':p?'positive':'')}>{p?(p.pnlUsd>0?'+':'')+currency(p.pnlUsd):'—'}</div>
   <div className={'gain '+(loss?'negative':'positive')}>{p?(p.roe>0?'+':'')+p.roe.toFixed(1)+'% ROE':unavailable?'Data unavailable':'No open position'}</div>
   <div className={"mini-chart"+(values.length>1?"":" empty-trend")}>{values.length>1?<svg viewBox="0 0 220 48" role="img" aria-label={market+' observed price trend'}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round"/></svg>:<span>{unavailable?'History unavailable':active?'Collecting price history':'Awaiting a position'}</span>}</div>
   <dl><div><dt>Collateral</dt><dd>{p?currency(p.collateralUsd):'—'}</dd></div><div><dt>Mark</dt><dd>{p?markPrice(p.mark):prices[market]?markPrice(prices[market]!):'—'}</dd></div><div><dt>ROE</dt><dd className={loss?'negative':'positive'}>{p?(p.roe>0?'+':'')+p.roe.toFixed(1)+'%':'—'}</dd></div><div><dt>Est. liquidation</dt><dd className={active&&distance<5?'negative':''}>{p?markPrice(p.liquidation):'—'}</dd></div></dl>
   <div className="tp-track" role="progressbar" aria-label={market+' progress toward take profit'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress??0}><span style={{width:(progress??0)+'%'}}/></div>
   <div className="card-caption"><span>{p?currency(p.notionalUsd)+' notional':unavailable?'Position unavailable':'No position'}</span><span>{progress===null?'TP —':Math.round(progress)+'% to TP'}</span></div>
   <footer><span className="status-dot"/>{unavailable?'Connection unavailable':p?.status==='liquidated'?'Liquidated':active?'Open · '+distance.toFixed(1)+'% to liquidation':p?'Closed':'No open position'}{p?.note&&<span title={p.note}> · {p.note}</span>}</footer>
  </article>;
 })}</div>;
}
