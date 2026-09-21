// Structured application events only: never mirror arbitrary provider stdout or request bodies.
export function adminLogs(sqlite,env){
 sqlite.exec('CREATE TABLE IF NOT EXISTS admin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL)');
 function redact(value){let text=String(value);for(const [key,secret] of Object.entries(env))if(/KEY|SECRET|PASSWORD|RPC_URL/i.test(key)&&typeof secret==='string'&&secret.length>3)text=text.split(secret).join('[redacted]');return text.replace(/https?:\/\/[^\s]+/gi,'[URL hidden]').replace(/(?:bearer\s+)[^\s]+/gi,'Bearer [redacted]').slice(0,1200);}
 return {write(level,source,message){if(!['info','warn','error'].includes(level))level='info';if(!['server','rpc','settings','trading','transaction','cycle'].includes(source))source='server';const clean=redact(message),last=sqlite.prepare('SELECT * FROM admin_logs ORDER BY id DESC LIMIT 1').get();if(last&&last.level===level&&last.source===source&&last.message===clean&&Date.now()-last.time<60000)return;
  sqlite.prepare('INSERT INTO admin_logs(time,level,source,message) VALUES(?,?,?,?)').run(Date.now(),level,source,clean);sqlite.exec('DELETE FROM admin_logs WHERE id NOT IN (SELECT id FROM admin_logs ORDER BY id DESC LIMIT 1000)');
 },read(){return sqlite.prepare('SELECT * FROM admin_logs ORDER BY id DESC LIMIT 200').all().map(row=>({...row,message:redact(row.message)}));}};
}
