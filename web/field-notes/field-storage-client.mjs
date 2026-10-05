// Dedicated request channel: a failed storage request cannot block Files/PDF replies.
export function storageClient(bridge,{timeout=30000}={}){
 const pending=new Map();
 const reply=(id,value,error)=>{const job=pending.get(id);if(!job)return;pending.delete(id);clearTimeout(job.timer);error?job.reject(new Error(error)):job.resolve(value);};
 const request=(method,args={})=>new Promise((resolve,reject)=>{
  const id=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Notebook operation timed out. Your current notes are still open; retry or export them.'));},method==='backup'?120000:timeout);
  pending.set(id,{resolve,reject,timer});try{bridge.postMessage({action:'storage',id,method,args});}catch(error){reply(id,null,error.message);}
 });return {request,reply};
}
// Migration is resumable per visit. Never remove the original IndexedDB records.
export async function migrateLegacy(request,legacy){
 const status=await request('status');if(status.migrationComplete)return status;
 const visits=await legacy.allVisits();
 for(const visit of visits){
  if(await request('getVisit',{id:visit.id}))continue;
  const photos=[];for(const meta of visit.photos??[]){const photo=await legacy.getPhoto(meta.id);if(!photo)throw new Error('An existing visit photo is unavailable. Migration stopped; the original notebook was kept.');photos.push(photo);}
  await request('migrateVisit',{visits:[visit],photos});
 }
 return request('migrationComplete');
}
