import * as legacy from './field-idb.mjs';
import {storageClient,migrateLegacy} from './field-storage-client.mjs';
const bridge=globalThis.window?.webkit?.messageHandlers?.fieldNotes;
let client,ready;
if(bridge){client=storageClient(bridge);window.fieldNotesStorageReply=client.reply;}
export async function initializeStorage(){
 if(!client)return {backend:'indexeddb'};
 if(!ready)ready=migrateLegacy(client.request,legacy).then(async status=>{await client.request('applyLocalRepair');return status;}).catch(error=>{ready=undefined;throw error;});
 return ready;
}
async function request(method,args={}){await initializeStorage();return client.request(method,args);}
export const putVisit=v=>client?request('commit',{visits:[v]}):legacy.putVisit(v);
export const allVisits=()=>client?request('allVisits'):legacy.allVisits();
export const getVisit=id=>client?request('getVisit',{id}):legacy.getVisit(id);
export const getPhoto=id=>client?request('getPhoto',{id}):legacy.getPhoto(id);
export const commitVisits=(visits,photos=[],removed=[])=>client?request('commit',{visits,photos,removed}):legacy.commitVisits(visits,photos,removed);
export const nativeBackup=(active,currentOnly)=>request('backup',{active,currentOnly});
export const storageStatus=()=>client?request('status'):Promise.resolve({backend:'indexeddb'});
