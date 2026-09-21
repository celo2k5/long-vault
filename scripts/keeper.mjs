import {randomUUID} from 'node:crypto';
const base=process.env.KEEPER_BASE_URL;const secret=process.env.KEEPER_SECRET;const interval=Number(process.env.KEEPER_INTERVAL_MS||15000);
if(!base||!secret||secret.length<32||!Number.isFinite(interval)||interval<5000)throw Error('Set KEEPER_BASE_URL, KEEPER_SECRET (32+ characters) and an interval >=5000ms.');
const url=new URL('/api/keeper',base);if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Use HTTPS for remote keepers.');
let stopped=false;process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
while(!stopped){const key='keeper:'+randomUUID();let done=false;for(let attempt=0;attempt<4&&!stopped;attempt++){try{const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+secret,'Idempotency-Key':key},signal:AbortSignal.timeout(15000),redirect:'error'});if(response.ok){console.log(new Date().toISOString(),'Keeper cycle committed');done=true;break;}if(response.status>=400&&response.status<500){console.error('Keeper rejected:',response.status);break;}throw Error('Server unavailable');}catch{console.error('Keeper attempt failed',attempt+1);await sleep(1000*2**attempt);}}if(!done)console.error('Cycle not confirmed; mock-only retries are safe. Inspect activity and deployment logs.');await sleep(interval);}

