// A local-only preview for environments unable to launch Cloudflare workerd.
import './windows-compat.mjs';
import {build} from 'vite';
import {resolve} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import ts from 'typescript';
await build({configFile:false,resolve:{alias:{'@':resolve('.')}},build:{outDir:'.sites-runtime/preview',emptyOutDir:true,rollupOptions:{input:'portable/index.html'}}});
await mkdir('.sites-runtime/lib',{recursive:true});
for(const name of ['address','engine','store','mainnet','connections']){const source=await readFile('lib/'+name+'.ts','utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace("../node_modules/", "../../node_modules/").replace(/from '\.\/(\w+)\.ts'/g,"from './$1.mjs'");await writeFile('.sites-runtime/lib/'+name+'.mjs',js);}



