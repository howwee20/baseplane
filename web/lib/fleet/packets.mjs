// Deliberately saved offline field packets (read/print only). Packets are copies of server plans: they never hold gate
// codes, carry a saved-at time, and are removed on sign-out. The Field Notes notebook is separate and never touched here.
const PREFIX='fleet-packet:';
const store=()=>{try{return globalThis.localStorage||null;}catch{return null;}};
export function savePacket(plan,notes,user,now=new Date().toISOString()){
 const s=store();if(!s)throw Error('This browser does not allow saving offline packets.');
 const safeNotes=Object.fromEntries(Object.entries(notes||{}).map(([id,n])=>[id,{accessNotes:n?.accessNotes||'',hazards:n?.hazards||'',entrance:n?.entrance||null,accessWindows:n?.accessWindows||null,region:n?.region||null}]));
 const {inputs,result,navigation,geometry,routing,forecast,title,date,crew,status,id,revision}=plan;
 const packet={kind:'enviroweather-field-packet',version:1,savedAt:now,savedBy:user?.email||'',plan:{id,revision,title,date,crew,status,inputs:{start:inputs?.start,end:inputs?.end,departLocal:inputs?.departLocal,returnByLocal:inputs?.returnByLocal},result,navigation,geometry,routing,forecast},notes:safeNotes};
 const text=JSON.stringify(packet);if(text.length>2_000_000)throw Error('This plan is too large to save offline.');
 try{s.setItem(PREFIX+id,text);}catch{throw Error('Device storage is full or blocked; the packet was not saved.');}
 return packet;
}
export function listPackets(email){
 const s=store();if(!s)return [];const out=[];
 for(let i=0;i<s.length;i++){const k=s.key(i);if(!k?.startsWith(PREFIX))continue;try{const p=JSON.parse(s.getItem(k));if(email&&p.savedBy!==email)continue;out.push({id:p.plan.id,title:p.plan.title,date:p.plan.date,savedAt:p.savedAt,savedBy:p.savedBy,stops:p.plan.result?.stops?.length||0});}catch{}}
 return out.sort((a,b)=>a.date.localeCompare(b.date));
}
export function getPacket(id){const s=store();if(!s)return null;try{return JSON.parse(s.getItem(PREFIX+id));}catch{return null;}}
export function removePacket(id){store()?.removeItem(PREFIX+id);}
export function clearPackets({keepEmail=null}={}){const s=store();if(!s)return;const keys=[];for(let i=0;i<s.length;i++){const k=s.key(i);if(k?.startsWith(PREFIX))keys.push(k);}for(const k of keys){if(keepEmail){try{if(JSON.parse(s.getItem(k)).savedBy===keepEmail)continue;}catch{}}s.removeItem(k);}}
