import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {loadDeveloperWallet} from '../.sites-runtime/lib/dev-wallet.mjs';

// The encryption key is never stored in SQLite or exposed through an API.
// Prefer WALLET_ENCRYPTION_KEY in Railway secrets; otherwise keep a 0600 key file
// on the private persistent volume. Back up that file separately from the database.
export function walletSecrets(sqlite,env){
 sqlite.exec('CREATE TABLE IF NOT EXISTS developer_secret (id INTEGER PRIMARY KEY CHECK(id=1), ciphertext TEXT NOT NULL, public_key TEXT NOT NULL)');
 sqlite.exec('CREATE TABLE IF NOT EXISTS runtime_settings (id INTEGER PRIMARY KEY CHECK(id=1), ciphertext TEXT NOT NULL)');
 function key(){
  if(env.WALLET_ENCRYPTION_KEY){const value=Buffer.from(env.WALLET_ENCRYPTION_KEY,'base64');if(value.length!==32)throw Error('WALLET_ENCRYPTION_KEY must encode 32 bytes');return value;}
  if(!env.DATA_DIR)throw Error('Attach a persistent volume and set DATA_DIR before saving a wallet');
  mkdirSync(env.DATA_DIR,{recursive:true});const path=join(env.DATA_DIR,'.wallet-encryption-key');
  try{const value=readFileSync(path);if(value.length!==32)throw Error('Invalid wallet encryption key');return value;}catch(e){if(e.code!=='ENOENT')throw e;}
  const value=randomBytes(32);try{writeFileSync(path,value,{flag:'wx',mode:0o600});return value;}catch(e){value.fill(0);if(e.code==='EEXIST')return key();throw e;}
 }
 return {
  saveSettings(settings){const master=key(),iv=randomBytes(12);try{const cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from('long-runtime-settings-v1'));const encrypted=Buffer.concat([cipher.update(JSON.stringify(settings),'utf8'),cipher.final()]);const payload=JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});sqlite.prepare('INSERT INTO runtime_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext').run(payload);}finally{master.fill(0);}},
  readSettings(){const row=sqlite.prepare('SELECT ciphertext FROM runtime_settings WHERE id=1').get();if(!row)return null;const master=key();try{const p=JSON.parse(row.ciphertext);if(p.version!==1)throw Error('Unsupported settings format');const decipher=createDecipheriv('aes-256-gcm',master,Buffer.from(p.iv,'base64'));decipher.setAAD(Buffer.from('long-runtime-settings-v1'));decipher.setAuthTag(Buffer.from(p.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(p.data,'base64')),decipher.final()]).toString('utf8'));}catch{throw Error('Stored connections cannot be decrypted.');}finally{master.fill(0);}},
  save(secret){const publicKey=loadDeveloperWallet(secret).publicKey.toBase58(),master=key(),iv=randomBytes(12);try{const cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from(publicKey));const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);const payload=JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});sqlite.prepare('INSERT INTO developer_secret VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,public_key=excluded.public_key').run(payload,publicKey);return publicKey;}finally{master.fill(0);}},
  read(){const row=sqlite.prepare('SELECT * FROM developer_secret WHERE id=1').get();if(!row)return null;const master=key();try{const p=JSON.parse(row.ciphertext);if(p.version!==1)throw Error('Unsupported wallet format');const decipher=createDecipheriv('aes-256-gcm',master,Buffer.from(p.iv,'base64'));decipher.setAAD(Buffer.from(row.public_key));decipher.setAuthTag(Buffer.from(p.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(p.data,'base64')),decipher.final()]).toString('utf8');}catch{throw Error('Stored wallet cannot be decrypted. Restore its encryption key.');}finally{master.fill(0);}}
 };
}
