const textFields=new Set('siteName siteId date timeIn timeOut technicians ticket maintenance maintenanceOn maintenanceOff observations grassNotes windSpeed windDirection windOther airTemp humidity airModel airOther solarOpen solarCovered sky lws0Wet lws0Dry lws1Wet lws1Dry rain1 rain3 additionalSensors powerSource panelVoltage batteryVoltage batteryCondition batteryType batteryAh sensorReplaced notes'.split(' '));
for(const d of [5,10,20,50,100])textFields.add('soilTemp'+d);
for(const d of [5,10,20,30,50,60,100])textFields.add('soilMoisture'+d);
const booleanFields=new Set('grassDone windDone windVerified airDone airInspected solarDone solarCleaned lws0Done lws0Cleaned lws1Done lws1Cleaned rainDone rainLeveled rainCleaned soilDone powerDone panelDone batteryDone batteryBoxDone picturesTaken'.split(' '));
const longFields=new Set(['observations','additionalSensors','notes']);
export const MAX_VISIT_BYTES=128*1024;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function bounded(value,depth=0){
 if(depth>4)throw Error('Visit metadata is too deeply nested.');
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='number'&&Number.isFinite(value))return;
 if(typeof value==='string'&&value.length<=10000)return;
 if(Array.isArray(value)&&value.length<=100){for(const item of value)bounded(item,depth+1);return;}
 if(plain(value)&&Object.keys(value).length<=80){for(const [key,item]of Object.entries(value)){if(key.length>100||['__proto__','constructor','prototype'].includes(key))throw Error('Invalid visit metadata.');bounded(item,depth+1);}return;}
 throw Error('Invalid or oversized visit metadata.');
}
export function validateVisitContent(v,{local=false}={}){
 if(!plain(v)||v.schemaVersion!==1||typeof v.id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(v.id)||!['draft','complete'].includes(v.status)||typeof v.updated!=='string'||v.updated.length>40||!Number.isFinite(Date.parse(v.updated)))throw Error('This is not a valid Field Notes visit.');
 if(!plain(v.fields)||Object.keys(v.fields).length>100||!plain(v.sources)||(v.history!==undefined&&!Array.isArray(v.history)))throw Error('Invalid visit fields or sources.');
 for(const [key,value]of Object.entries(v.fields)){
  if(booleanFields.has(key)){if(typeof value!=='boolean')throw Error('Invalid checkbox value.');}
  else if(!textFields.has(key)||typeof value!=='string'||(!local&&value.length>(longFields.has(key)?10000:500)))throw Error('Invalid or oversized visit field: '+key);
 }
 if(v.fields.date!==undefined&&v.fields.date!==''&&(!/^\d{4}-\d{2}-\d{2}$/.test(v.fields.date)||new Date(v.fields.date+'T00:00:00Z').toISOString().slice(0,10)!==v.fields.date))throw Error('Choose a valid visit date.');
 if(!local&&(v.fields.siteName?.length>200||v.fields.siteId?.length>100))throw Error('Station name or ID is too long.');
 for(const [key,source]of Object.entries(v.sources)){if(!textFields.has(key)||!plain(source))throw Error('Invalid reading source.');if(!local)bounded(source);}
 if(!local&&(v.history??[]).length>500)throw Error('Too many reading-source changes. Export a backup and start a follow-up visit.');
 for(const source of v.history??[]){if(!plain(source)||!textFields.has(source.field))throw Error('Invalid source history.');if(!local)bounded(source);}
 if(v.visitPlan!==undefined){if(!plain(v.visitPlan))throw Error('Invalid visit plan.');if(!local)bounded(v.visitPlan);}
 if(v.color!==undefined&&(typeof v.color!=='string'||v.color.length>40))throw Error('Invalid visit color.');
 if(v.archived!==undefined&&typeof v.archived!=='boolean')throw Error('Invalid visit archive state.');
 if(v.publishedRevision!==undefined&&v.publishedRevision!==null&&(typeof v.publishedRevision!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(v.publishedRevision)))throw Error('Invalid publication revision.');
 const content={schemaVersion:1,id:v.id,updated:v.updated,status:v.status,fields:v.fields,sources:v.sources,history:v.history??[],...(v.visitPlan?{visitPlan:v.visitPlan}:{}),...(v.color?{color:v.color}:{}),...(v.archived!==undefined?{archived:v.archived}:{})};
 if(!local&&new TextEncoder().encode(JSON.stringify(content)).byteLength>MAX_VISIT_BYTES)throw Error('Visit text is too large. Export a backup and start a follow-up visit.');
 return content;
}
export function visitSummary(v){return {id:v.id,status:v.status,updated:v.updated,sharedAt:v.sharedAt,sharedBy:v.sharedBy,fields:{siteName:v.fields.siteName,siteId:v.fields.siteId||'',date:v.fields.date,technicians:v.fields.technicians||'',ticket:v.fields.ticket||''}};}
