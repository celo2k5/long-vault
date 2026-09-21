import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export function openStore(filename){
 mkdirSync(dirname(filename),{recursive:true});
 const sqlite=new DatabaseSync(filename);
 sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
 const journal=JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
 for(const migration of journal.entries){
  if(sqlite.prepare('SELECT 1 FROM local_migrations WHERE name=?').get(migration.tag))continue;
  sqlite.exec('BEGIN IMMEDIATE');try{sqlite.exec(readFileSync(new URL('../drizzle/'+migration.tag+'.sql',import.meta.url),'utf8'));sqlite.prepare('INSERT INTO local_migrations VALUES (?)').run(migration.tag);sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');sqlite.close();throw e;}
 }
 function prepare(query){let args=[];return {bind(...values){args=values;return this;},async first(){return sqlite.prepare(query).get(...args)||null;},async all(){return {results:sqlite.prepare(query).all(...args)};},async run(){return this.sync();},sync(){return {meta:{changes:Number(sqlite.prepare(query).run(...args).changes)}};}};}
 return {sqlite,db:{prepare,async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const rows=statements.map(s=>s.sync());sqlite.exec('COMMIT');return rows;}catch(e){sqlite.exec('ROLLBACK');throw e;}}}};
}
