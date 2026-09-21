"use client";
import {useEffect,useState,useCallback,useRef} from 'react';
import {Copy} from 'lucide-react';
import {Toaster,toast} from 'sonner';
import {MainnetOverview} from './Connections';
import {AdminConsole} from './AdminConsole';
import {ConnectionSettings} from './ConnectionSettings';
import {StrategySettings} from './StrategySettings';
import {LiveTrading} from './LiveTrading';
import {defaults,type Config} from '@/lib/engine';
import type {WalletStatus} from '@/lib/dev-wallet';
type View={testMode?:boolean;authProvider?:string;config:Config;developerWallet?:WalletStatus;walletStorageError?:string;storagePersistent?:boolean;trading?:{enabled:boolean;paused:boolean;phase?:string;nextAt?:number}};
export default function VaultDashboard({view='overview'}:{view?:'overview'|'admin'}){
 const admin=view==='admin';
 const [data,setData]=useState<View|null>(null),[ca,setCa]=useState(''),[key,setKey]=useState(''),[cycle,setCycle]=useState(120),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const initialized=useRef(false);
 const refresh=useCallback(async()=>{try{const r=await fetch(admin?'/api/vault':'/api/public',{cache:'no-store'});const value=await r.json() as View & {error?:string};if(!r.ok)throw Error(value.error||'Vault unavailable');setData(value);setError('');if(!initialized.current){setCa(value.config.tokenMint);setCycle(value.config.cooldownSeconds);initialized.current=true;}}catch(e){setError(e instanceof Error?e.message:'Vault unavailable');}},[admin]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[refresh]);
 async function copy(value:string){try{await navigator.clipboard.writeText(value);toast.success('Copied');}catch{toast.error('Could not copy address');}}
 async function save(){if(busy)return;setBusy(true);try{const r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tokenMint:ca.trim(),cycleSeconds:cycle,...(key?{privateKey:key.trim()}:{})})});const result=await r.json() as {error?:string};if(!r.ok)throw Error(result.error||'Setup failed');setKey('');await refresh();toast.success('Saved. Cycles are paused until you enable them.');}catch(e){toast.error(e instanceof Error?e.message:'Save could not be confirmed. Check the current wallet before retrying.');}finally{setBusy(false);}}
 const config=data?.config||{...defaults,dataSource:'mainnet' as const};
 return <><header className="topbar"><a className="wordmark" href="/">LONG<span> / VAULT</span></a>{admin&&<a className="admin-link" href="/">← Back to $LONG</a>}</header><main className={admin?'admin-page':'dashboard'}>
 {admin?<div className="admin-heading"><form method="post" action="/admin/logout"><button className="text-button">Sign out</button></form><span className="eyebrow">LONG CONTROL</span><h1>Admin</h1><p>One token. One developer wallet. One cycle.</p></div>:<div className="hero"><div className="token-emblem"><img src="/long-pfp.png" alt="$LONG profile icon" width={1254} height={1254}/></div><h1>$LONG</h1><p>BTC, ETH &amp; SOL. One wallet.<br/><span>Creator rewards. Long positions. $LONG.</span></p><div className="address"><label>TOKEN CA</label><span>{config.tokenMint||'Not configured'}</span>{config.tokenMint&&<button aria-label="Copy token contract address" onClick={()=>copy(config.tokenMint)}><Copy size={12}/></button>}</div></div>}
 {error&&<p role="alert" className="error-box">{error} {admin&&<a href="/admin/login">Sign in</a>}</p>}
 {!admin&&<MainnetOverview config={config} copy={copy} trading={data?.trading}/>}
 {admin&&<div className="admin-content"><form onSubmit={e=>{e.preventDefault();void save();}}><section className="panel settings-section"><h2>Setup</h2><div className="field-grid">
 <label>$LONG token CA{data?.testMode?' (optional in test mode)':''}<input required={!data?.testMode} autoComplete="off" spellCheck={false} value={ca} placeholder="Token contract address" onChange={e=>setCa(e.target.value)}/><small>Updates the public website and identifies the fee creator.</small></label>
 <label>Developer wallet private key<input type="password" disabled={data?.authProvider!=='password'} autoComplete="new-password" spellCheck={false} maxLength={512} value={key} required={!data?.developerWallet?.publicKey} placeholder={data?.developerWallet?.publicKey?'Wallet saved · leave blank to keep':'Base58 key or JSON byte array'} onChange={e=>setKey(e.target.value)}/><small>Encrypted on the server. Never displayed again. This wallet claims the fees and funds the longs.</small></label>
 <label>Cycle interval (seconds)<input required type="number" min={10} max={86400} step={1} value={Number.isFinite(cycle)?cycle:''} onChange={e=>setCycle(e.target.value===''?NaN:Number(e.target.value))}/><small>Wait after a completed cycle before starting the next.</small></label></div>
 {data?.developerWallet?.publicKey&&<p className="admin-note">Developer wallet <code>{data.developerWallet.publicKey}</code></p>}{data?.walletStorageError&&<p role="alert" className="negative">{data.walletStorageError}</p>}{data?.storagePersistent===false&&<p className="negative">Attach a Railway volume and set DATA_DIR=/data to save the wallet.</p>}
 <p className="admin-note">{data&&data.authProvider!=='password'?'Local preview only. Save your wallet on the deployed Admin page.':''}</p><div className="actions"><button className="primary" disabled={busy||!data||data.authProvider!=='password'}>{busy?'Saving…':'Save setup'}</button></div><p className="admin-note">Current strategy: {config.leverage}× longs · BTC {config.allocation.BTC}% / ETH {config.allocation.ETH}% / SOL {config.allocation.SOL}% · TP +{config.takeProfit}% / SL −{config.stopLoss}% ROE · ${config.maxPositionUsd} maximum per position.</p></section></form>{data&&<StrategySettings config={config} enabled={data.authProvider==='password'} onSaved={refresh}/>}{data&&<ConnectionSettings enabled={data.authProvider==='password'}/>}<LiveTrading/>{data&&<AdminConsole enabled={data.authProvider==='password'}/>}</div>}
 <div className="bottom"><span>LONG</span><span>Solana mainnet</span></div></main><Toaster theme="dark" richColors/></>;
}
