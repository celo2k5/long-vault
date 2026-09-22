import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPublicKey} from '../lib/address.ts';
import {defaults,initialState,transition,validateConfig} from '../lib/engine.ts';
import {boundedFetch,parsePositions,perpsBase,rpcConnection,MINTS} from '../lib/mainnet.ts';

test('address validation rejects base58 strings with the wrong decoded length',()=>{
 assert.equal(isPublicKey(MINTS.USDC),true);assert.equal(isPublicKey('1'.repeat(32)),true);
 assert.equal(isPublicKey('z'.repeat(44)),false);assert.equal(isPublicKey('1'.repeat(33)),false);assert.equal(isPublicKey('0'.repeat(32)),false);
 assert.throws(()=>validateConfig({...defaults,tokenMint:'1'.repeat(33)}));
});
test('mainnet monitoring cannot run the simulated economic engine',()=>{
 const state=initialState();state.config.dataSource='mainnet';
 for(const type of ['tick','claim','buyback','close'] as const){const result=transition(state,{type},'monitor-'+type);assert.match(result.error!,/read-only/);assert.equal(result.state.ready,state.ready);assert.equal(result.state.pending,state.pending);assert.equal(result.state.cycle,0);}
 const result=transition(state,{type:'configure',config:{...state.config,tokenMint:MINTS.USDC}},'config-mainnet');assert.equal(result.error,undefined);assert.equal(result.state.config.tokenMint,MINTS.USDC);
});
test('Jupiter position units are converted from micro-USD, including losses',()=>{
 const position={positionPubkey:MINTS.SOL,asset:'SOL',side:'long',leverage:'5',sizeUsd:'500000000',collateralUsd:'100000000',entryPriceUsd:'150000000',markPriceUsd:'149000000',liquidationPriceUsd:'125000000',pnlAfterFeesUsd:'-4300000',pnlAfterFeesPct:'-4.3',tpslRequests:[{requestType:'tp',triggerPriceUsd:'180000000'},{requestType:'sl',triggerPriceUsd:'142500000'}]};
 const [p]=parsePositions({count:1,dataList:[position]});assert.equal(p.notionalUsd,500);assert.equal(p.mark,149);assert.equal(p.pnlUsd,-4.3);assert.equal(p.takeProfitPrice,180);assert.equal(p.stopLossPrice,142.5);
 assert.throws(()=>parsePositions({count:2,dataList:[position]}),/Incomplete/);
 assert.throws(()=>parsePositions({count:1,dataList:[{...position,markPriceUsd:'NaN'}]}));
 assert.throws(()=>parsePositions({count:1,dataList:[{...position,collateralUsd:'-1'}]}));
 assert.throws(()=>parsePositions({count:1,dataList:[{...position,sizeUsd:'999999999999999999999'}]}));
});
test('API destination cannot be changed to a credential exfiltration endpoint',()=>{
 assert.equal(perpsBase({}),'https://perps-api.jup.ag/v2');assert.throws(()=>perpsBase({JUPITER_API_URL:'https://example.com'}));
 assert.throws(()=>rpcConnection({}),/server secrets/);assert.throws(()=>rpcConnection({SOLANA_RPC_URL:'http://localhost:8899'}),/HTTPS/);
});
test('reads retry transient failures but never follow redirects',async()=>{
 let attempts=0;
 const fetcher=(async(_input:unknown,init:RequestInit)=>{assert.equal(init.redirect,'error');attempts++;return new Response('{}',{status:attempts<3?503:200});}) as typeof fetch;
 assert.equal((await boundedFetch('https://example.com',{},fetcher)).status,200);assert.equal(attempts,3);
 let authAttempts=0;await assert.rejects(boundedFetch('https://example.com',{},(async()=>{authAttempts++;return new Response('{}',{status:401});}) as typeof fetch),/HTTP 401/);assert.equal(authAttempts,1);
});
test('network errors do not disclose secret-bearing provider URLs',async()=>{
 await assert.rejects(boundedFetch('https://example.com',{},(async()=>{throw Error('Failed https://rpc.example/?api-key=secret');}) as typeof fetch),e=>e instanceof Error&&!e.message.includes('secret')&&e.message.includes('Network'));
});

test('mainnet verification accepts the full cluster hash and rejects truncated or devnet hashes',async()=>{
 const {MAINNET_GENESIS,confirmedMainnet}=await import('../lib/mainnet.ts');
 assert.equal(MAINNET_GENESIS,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
 await confirmedMainnet({getGenesisHash:async()=>MAINNET_GENESIS} as never);
 await assert.rejects(confirmedMainnet({getGenesisHash:async()=>'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'} as never),/not Solana mainnet/);
 await assert.rejects(confirmedMainnet({getGenesisHash:async()=>'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'} as never),/not Solana mainnet/);
});

 test('execution transport leaves retries to the persisted-order reconciler',async()=>{
 let attempts=0;
 const fetcher=(async()=>{attempts++;return new Response('{}',{status:503});}) as typeof fetch;
 await assert.rejects(boundedFetch('https://example.com',{},fetcher,1),/HTTP 503/);
 assert.equal(attempts,1);
 });

test('Jupiter execution reports bounded rejection details, redacts credentials and never retries internally',async()=>{
 const {jupiter,JupiterSubmissionError}=await import('../lib/mainnet.ts');const original=globalThis.fetch;let calls=0;
 globalThis.fetch=(async(_url,init)=>{calls++;assert.equal(new Headers(init?.headers).get('x-perps-api-version'),'v2');assert.equal(init?.redirect,'error');return new Response(JSON.stringify({code:'bad_request',message:'Invalid signature private-test-key https://rpc.example/secret '+ 'A'.repeat(90),metadata:{secret:'metadata-must-not-leak'}}),{status:400});}) as typeof fetch;
 try{await assert.rejects(jupiter({JUPITER_API_KEY:'private-test-key'},'transaction/execute',{serializedTxBase64:'A'.repeat(90),action:'increase-position'}),e=>e instanceof JupiterSubmissionError&&e.status===400&&e.detail.includes('Invalid signature')&&!/private-test-key|rpc.example|metadata-must-not-leak|AAAA/.test(e.detail));assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

test('loaded JSON and base58 wallet keys retain valid signing material after decoder cleanup',async()=>{
 const {loadDeveloperWallet}=await import('../lib/dev-wallet.ts');
 const {Keypair,TransactionMessage,VersionedTransaction}=await import('@solana/web3.js');
 const {createPublicKey,verify}=await import('node:crypto');
 const wallet=Keypair.generate(),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 let n=BigInt('0x'+Buffer.from(wallet.secretKey).toString('hex')),base58='';while(n){base58=alphabet[Number(n%BigInt(58))]+base58;n/=BigInt(58);}for(const b of wallet.secretKey){if(b)break;base58='1'+base58;}
 for(const secret of [JSON.stringify([...wallet.secretKey]),base58]){
  const loaded=loadDeveloperWallet(secret);assert.deepEqual(loaded.secretKey,wallet.secretKey);
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[]}).compileToV0Message());tx.sign([loaded]);
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),wallet.publicKey.toBuffer()]),format:'der',type:'spki'});
  assert.equal(verify(null,tx.message.serialize(),key,tx.signatures[0]),true);
 }
});
