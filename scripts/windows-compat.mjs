// Local launcher compatibility: Vite's optional Windows network-drive discovery
// throws synchronously when the environment cannot open child-process pipes.
// Treat that optional discovery failure like its documented async failure.
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.exec;
cp.exec=function(command,...args){try{return original.call(this,command,...args);}catch(error){if(command!=='net use')throw error;const callback=args.findLast(x=>typeof x==='function');if(callback)queueMicrotask(()=>callback(error,'',''));return undefined;}};
syncBuiltinESMExports();


// Keep errors visible; avoid esbuild-based formatting of informational proxy warnings.
process.env.WRANGLER_LOG ??= 'error';

