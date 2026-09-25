"use client";
import {useEffect,useRef,useState} from 'react';
export function HoloCandle(){
 const host=useRef<HTMLDivElement>(null),[ready,setReady]=useState(false);
 useEffect(()=>{let cancelled=false,dispose:(()=>void)|undefined;import('./holo-candle').then(({mountCandle})=>{if(!cancelled&&host.current)dispose=mountCandle(host.current,()=>setReady(true));}).catch(()=>{if(host.current)host.current.dataset.fallback='true';});return()=>{cancelled=true;dispose?.();};},[]);
 return <div className="holo-visual"><div className="holo-stage" ref={host} aria-hidden="true" data-ready={ready}><div className="candle-fallback"><i/></div></div><span className="holo-caption">ONE CANDLE. A CONTINUOUS CYCLE.</span></div>;
}
