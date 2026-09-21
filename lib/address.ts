const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Validate canonical 32-byte base58 public keys without shipping a signing SDK. */
export function isPublicKey(value:unknown):value is string {
 if(typeof value!=='string'||value.length<32||value.length>44)return false;
 let n=BigInt(0);for(const char of value){const digit=alphabet.indexOf(char);if(digit<0)return false;n=n*BigInt(58)+BigInt(digit);}
 let bytes=0;while(n>0){bytes++;n>>=BigInt(8);}let zeros=0;while(value[zeros]==='1')zeros++;
 return bytes+zeros===32;
}
