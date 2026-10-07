// Bounded server-side cache for provider responses (forecasts, routes). Rows expire; nothing here is private team data.
const MAX_BYTES=1_500_000;// below the D1 2 MB row limit
export async function cacheRead(db,key,{allowExpired=false}={}){
 const row=await db.prepare('SELECT fetched_at,expires,body FROM provider_cache WHERE key=?').bind(key).first();
 if(!row||(!allowExpired&&row.expires<Date.now()))return null;
 return {fetchedAt:row.fetched_at,expired:row.expires<Date.now(),body:JSON.parse(row.body)};
}
export async function cacheWrite(db,key,body,ttlMs,fetchedAt=new Date().toISOString()){
 const text=JSON.stringify(body);if(text.length>MAX_BYTES)throw Error('Provider response too large to cache.');
 await db.prepare('INSERT INTO provider_cache(key,fetched_at,expires,body) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET fetched_at=excluded.fetched_at,expires=excluded.expires,body=excluded.body').bind(key,fetchedAt,Date.now()+ttlMs,text).run();
 return {fetchedAt,body};
}
export async function pruneCache(db,olderThanMs=7*864e5){await db.prepare('DELETE FROM provider_cache WHERE expires<?').bind(Date.now()-olderThanMs).run();}
export async function boundedFetch(url,init={},{timeoutMs=20000,retries=1,retryDelayMs=1500}={}){
 let last;
 for(let attempt=0;attempt<=retries;attempt++){
  try{const res=await fetch(url,{...init,signal:AbortSignal.timeout(timeoutMs)});if(res.status===429||res.status>=500){last=Object.assign(Error('Provider HTTP '+res.status),{status:res.status});if(attempt<retries){await new Promise(r=>setTimeout(r,retryDelayMs*(attempt+1)));continue;}throw last;}return res;}
  catch(e){last=e;if(attempt<retries&&!(e.status&&e.status<500&&e.status!==429)){await new Promise(r=>setTimeout(r,retryDelayMs*(attempt+1)));continue;}throw last;}
 }
 throw last;
}
