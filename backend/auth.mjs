import {scrypt,randomBytes,timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {AppError} from './storage.mjs';
export const randomToken=()=>randomBytes(32).toString('hex');
export const digest=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
export const normalizeEmail=v=>String(v||'').trim().toLowerCase();
export function validEmail(value){
 if(typeof value!=='string'||value.length>254)return false;
 const email=value.trim(),at=email.indexOf('@');
 return at>0&&at===email.lastIndexOf('@')&&at<email.length-1&&!/[\s]/.test(email)&&email.slice(at+1).includes('.')&&!email.endsWith('.')&&!email.slice(at+1).startsWith('.');
}
export async function passwordHash(password,salt){const key=await new Promise((resolve,reject)=>scrypt(password,salt,32,{N:16384,r:8,p:5,maxmem:32*1024*1024},(error,value)=>error?reject(error):resolve(value)));return key.toString('hex');}
export function safeEqual(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
export const publicUser=u=>({id:u.id,email:u.email,name:u.name,role:u.role});
export async function authenticate(req,env){
 const token=req.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];if(!token)return null;
 return env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.active=1 AND s.credential_version=u.credential_version').bind(await digest(token),Date.now()).first();
}
export async function rateLimit(db,key,limit=8){
 const now=Date.now(),until=now+900000;
 const row=await db.prepare('INSERT INTO attempts (key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count').bind(key,until,now,now).first();
 if(row.count>limit)throw new AppError('Too many attempts. Please try again in 15 minutes.',429);
}
export async function session(db,u){
 const token=randomToken();
 const result=await db.prepare('INSERT INTO sessions(hash,user_id,expires,credential_version) SELECT ?,id,?,credential_version FROM users WHERE id=? AND credential_version=? AND active=1').bind(await digest(token),Date.now()+7*86400000,u.id,u.credential_version).run();
 if(result.meta.changes!==1)throw new AppError('Your account changed. Sign in again.',401);
 return {token,user:publicUser(u)};
}
async function limitedHash(db,password,salt){
 const key='auth-kdf:'+randomToken(),now=Date.now();
 const acquired=await db.prepare("INSERT INTO locks(name,owner,expires) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM locks WHERE name LIKE 'auth-kdf:%' AND expires>?)<4").bind(key,key,now+60000,now).run();
 if(acquired.meta.changes!==1)throw new AppError('Sign-in is busy. Please retry shortly.',429);
 try{return await passwordHash(password,salt);}finally{await db.prepare('DELETE FROM locks WHERE name=? AND owner=?').bind(key,key).run();}
}
export async function changePassword(env,user,b){
 if(typeof b.currentPassword!=='string'||b.currentPassword.length>256)throw new AppError('Current password is incorrect.',403);
 if(typeof b.password!=='string'||b.password.length<14||b.password.length>256)throw new AppError('Use a password with 14–256 characters.');
 await rateLimit(env.DB,'password:'+user.id);
 if(!safeEqual(await limitedHash(env.DB,b.currentPassword,user.salt),user.password_hash))throw new AppError('Current password is incorrect.',403);
 const salt=randomToken(),hash=await limitedHash(env.DB,b.password,salt),version=user.credential_version;
 const results=await env.DB.batch([
  env.DB.prepare('UPDATE users SET password_hash=?,salt=?,credential_version=credential_version+1 WHERE id=? AND credential_version=? AND active=1').bind(hash,salt,user.id,version),
  env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND credential_version<=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND credential_version=? AND password_hash=? AND salt=?)').bind(user.id,version,user.id,version+1,hash,salt)
 ]);
 if(results[0].meta.changes!==1)throw new AppError('Your password or account changed. Sign in again before changing it.',409);
 return {ok:true};
}
export async function authRoute(req,env,path,b){
 if(path==='/auth/status')return {setupNeeded:!(await env.DB.prepare("SELECT id FROM users WHERE role='owner'").first())};
 if(req.method!=='POST')throw new AppError('Method not allowed.',405);
 if(!['/auth/login','/auth/register'].includes(path))throw new AppError('Endpoint not found.',404);
 const ip=req.headers.get('CF-Connecting-IP')||'local';
 await rateLimit(env.DB,'auth-ip:'+await digest(ip),40);
 if(!validEmail(b.email))throw new AppError(path==='/auth/login'?'Email or password is incorrect.':'Enter a valid email address.',path==='/auth/login'?401:400);
 const email=normalizeEmail(b.email);await rateLimit(env.DB,'auth:'+await digest(ip+':'+email));
 if(path==='/auth/login'){
  if(typeof b.password!=='string'||b.password.length>256)throw new AppError('Email or password is incorrect.',401);
  const u=await env.DB.prepare('SELECT * FROM users WHERE email=? AND active=1').bind(email).first();
  const hash=await limitedHash(env.DB,b.password,u?.salt||'constant-dummy-salt');if(!u||!safeEqual(hash,u.password_hash))throw new AppError('Email or password is incorrect.',401);
  return session(env.DB,u);
 }
 if(path==='/auth/register'){
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100)throw new AppError('Enter your name and email address.');
  if(typeof b.password!=='string'||b.password.length<14||b.password.length>256)throw new AppError('Use a password with at least 14 characters.');
  let role,inviteHash;
  const noOwner=!(await env.DB.prepare("SELECT id FROM users WHERE role='owner'").first());
  if(noOwner&&env.BOOTSTRAP_TOKEN&&safeEqual(b.token||'',env.BOOTSTRAP_TOKEN)&&email===env.OWNER_EMAIL)role='owner';
  else {inviteHash=await digest(String(b.token||''));const invite=await env.DB.prepare('SELECT * FROM invites WHERE hash=? AND used=0 AND expires>?').bind(inviteHash,Date.now()).first();if(!invite||invite.email!==email)throw new AppError('This invitation is invalid or expired.',403);role=invite.role;}
  const u={id:crypto.randomUUID(),email,name:b.name.trim(),role,salt:randomToken(),credential_version:0,created:new Date().toISOString()};u.password_hash=await limitedHash(env.DB,b.password,u.salt);
  const sql=[env.DB.prepare('INSERT INTO users(id,email,name,role,password_hash,salt,created) VALUES(?,?,?,?,?,?,?)').bind(u.id,u.email,u.name,u.role,u.password_hash,u.salt,u.created)];
  if(inviteHash)sql.push(env.DB.prepare('UPDATE invites SET used=1 WHERE hash=? AND used=0').bind(inviteHash));
  try{await env.DB.batch(sql);}catch{throw new AppError('An account already exists or this invitation was already used.',409);}
  return session(env.DB,u);
 }
 throw new AppError('Endpoint not found.',404);
}
