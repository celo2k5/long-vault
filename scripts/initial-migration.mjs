import {generateSQLiteDrizzleJson,generateSQLiteMigration} from 'drizzle-kit/api';
import * as schema from '../db/schema.ts';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
try{if(JSON.parse(await readFile('drizzle/meta/_journal.json','utf8')).entries.length)throw Error('Initial migration already exists; use drizzle-kit generate for subsequent migrations.');}catch(e){if(e.code!=='ENOENT')throw e;}
const before=await generateSQLiteDrizzleJson({});const after=await generateSQLiteDrizzleJson(schema,before.id);
const sql=await generateSQLiteMigration(before,after);
await mkdir('drizzle/meta',{recursive:true});await writeFile('drizzle/0000_tek_vault.sql',sql.join('\n--> statement-breakpoint\n'));
await writeFile('drizzle/meta/0000_snapshot.json',JSON.stringify(after,null,2));
await writeFile('drizzle/meta/_journal.json',JSON.stringify({version:'7',dialect:'sqlite',entries:[{idx:0,version:after.version,when:Date.now(),tag:'0000_tek_vault',breakpoints:true}]},null,2));
console.log(sql.join('\n'));


