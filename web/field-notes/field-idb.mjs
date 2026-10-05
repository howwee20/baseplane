let database;
const timeoutError=()=>new Error('The browser notebook did not respond. Retry saving or export the current visit.');
function open(){
 if(database)return database;
 database=new Promise((resolve,reject)=>{
  const request=indexedDB.open('field-notes-v1',2);let settled=false;
  const timer=setTimeout(()=>{settled=true;database=undefined;reject(timeoutError());},15000);
  request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('visits'))db.createObjectStore('visits',{keyPath:'id'});if(!db.objectStoreNames.contains('photos'))db.createObjectStore('photos',{keyPath:'id'});};
  request.onsuccess=()=>{if(settled){request.result.close();return;}clearTimeout(timer);request.result.onversionchange=()=>{request.result.close();database=undefined;};resolve(request.result);};
  request.onerror=()=>{clearTimeout(timer);database=undefined;reject(request.error);};
 });return database;
}
async function transact(stores,mode,operation){
 const db=await open();return new Promise((resolve,reject)=>{
  let tx,result,timer;const fail=error=>{clearTimeout(timer);reject(error??new Error('Notebook operation failed.'));};
  try{tx=db.transaction(stores,mode);timer=setTimeout(()=>{try{tx.abort();}catch{}fail(timeoutError());},15000);
   result=operation(tx);tx.oncomplete=()=>{clearTimeout(timer);resolve(typeof result==='function'?result():result?.result);};tx.onerror=()=>fail(tx.error);tx.onabort=()=>fail(tx.error??new Error('Save was interrupted; previous records were kept.'));
  }catch(error){fail(error);}
 });
}
export const putVisit=v=>transact(['visits'],'readwrite',tx=>tx.objectStore('visits').put(v));
export const allVisits=()=>transact(['visits'],'readonly',tx=>tx.objectStore('visits').getAll());
export const getVisit=id=>transact(['visits'],'readonly',tx=>tx.objectStore('visits').get(id));
export const getPhoto=id=>transact(['photos'],'readonly',tx=>tx.objectStore('photos').get(id));
export const commitVisits=(visits,photos=[],removed=[])=>transact(['visits','photos'],'readwrite',tx=>{for(const v of visits)tx.objectStore('visits').put(v);for(const p of photos)tx.objectStore('photos').put(p);for(const id of removed)tx.objectStore('photos').delete(id);});
