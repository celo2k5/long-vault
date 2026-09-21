// An explicit boundary: no plausible-looking but unverified live transactions.
export type LiveIntent={owner:string;mint:string;destination:string;amount:bigint;maxSlippageBps:number;expiresAt:number;allowedPrograms:readonly string[]};
export type VerifiedQuote={owner:string;inputMint:string;outputMint:string;destination:string;inputAmount:bigint;minOutputAmount:bigint;slippageBps:number;expiresAt:number;programs:readonly string[]};
export function validateQuote(q:VerifiedQuote,policy:LiveIntent,inputMint:string,now=Date.now()){
 if(q.owner!==policy.owner||q.inputMint!==inputMint||q.outputMint!==policy.mint||q.destination!==policy.destination)throw Error('Quote account or mint mismatch');
 if(q.inputAmount!==policy.amount||q.inputAmount<=BigInt(0)||q.minOutputAmount<=BigInt(0))throw Error('Invalid quote amount');
 if(!Number.isFinite(q.slippageBps)||q.slippageBps<0||q.slippageBps>policy.maxSlippageBps||!Number.isFinite(q.expiresAt)||q.expiresAt<=now||q.expiresAt>policy.expiresAt)throw Error('Stale quote or slippage policy violation');
 if(!q.programs.length||q.programs.some(p=>!policy.allowedPrograms.includes(p)))throw Error('Unapproved transaction program');
 // This validates quote metadata only. Decoding and validating every instruction,
 // signer and writable account is also required before any signer may be called.
 return true;
}
export function createLiveAdapter():never{throw Error('Live Pump/Jupiter adapters and vault authority are not implemented or audited. No signing or sending is available.');}


