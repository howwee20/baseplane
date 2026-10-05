import {parseVisitPlan,applyVisitPlan} from './field-plan.mjs';
import {request,hasSession} from '../auth.mjs';
import {renderForm} from './field-form.mjs?v=cleanup-1';
import {newVisit,validateVisit,parseStationData,readingTargets,suggestColumn,convertReading,escapeHtml as e,MAX_BACKUP_BYTES,prepareRestore} from './field-core.mjs?v=cleanup-1';
import {putVisit,allVisits,getVisit,getPhoto,commitVisits,initializeStorage,nativeBackup,storageStatus} from './field-store.mjs?v=cleanup-1';
const $=s=>document.querySelector(s),form=$('#sheet');form.innerHTML=renderForm();
let current,importData,saveChain=Promise.resolve(),saveError=false,photoBusy=false,photoRendering=Promise.resolve(),saveTimer,saveSequence=0;
let homeVisits=[],showArchived=false;
let colorVisitId;
const visitColors={none:{label:'No color',hex:'#d5dcd8'},green:{label:'Green',hex:'#43835e'},blue:{label:'Blue',hex:'#527ebd'},purple:{label:'Purple',hex:'#9370b4'},amber:{label:'Amber',hex:'#bd9039'},red:{label:'Red',hex:'#bc6470'},teal:{label:'Teal',hex:'#488f95'},gray:{label:'Gray',hex:'#7c8792'}};
const visitColor=visit=>visitColors[visit.color]??visitColors.none;
const unsavedVisits=new Map();
const native=!!window.webkit?.messageHandlers?.fieldNotes;
const state=t=>{$('#saveState').textContent=t};
function notice(t,error=false){$('#notice').textContent=t;$('#notice').className='notice'+(error?' error':'');$('#notice').hidden=false;}
function sources(){
 document.querySelectorAll('.field-source').forEach(x=>x.remove());
 for(const input of form.querySelectorAll('[name]'))delete input.dataset.imported;
 const entries=Object.entries(current.sources);$('#provenance').hidden=!entries.length;
 $('#sourceList').innerHTML=entries.map(([key,s])=>`<p><b>${e(readingTargets.find(t=>t.key===key)?.label??key)}</b> · ${e(s.value)} ${e(s.targetUnit)}<br>${e(s.station||'Station not supplied')} · ${e(s.table)} · ${e(s.column)} (${e(s.unit)}) · ${e(s.timestamp)} [logger clock]<br>${e(s.source)} · imported ${e(s.importedAt)}${s.edited?' · edited manually':''}</p>`).join('');
 for(const [key,s] of entries){const input=form.elements.namedItem(key);if(input instanceof HTMLInputElement){input.dataset.imported=String(!s.edited);const note=document.createElement('small');note.className='field-source';note.textContent=`${s.edited?'Edited after import':'Imported'} · ${s.column} · ${s.timestamp}`;const parent=input.closest('.field')??input.parentElement;parent.append(note);}}
}
function load(v){current=validateVisit(v);try{localStorage.setItem('field-notes-active-visit',current.id);}catch{}current.photos??=[];form.reset();for(const input of form.querySelectorAll('[name]')){const value=current.fields[input.name];if(input.type==='checkbox')input.checked=value===true;else if(input.type==='radio')input.checked=input.value===value;else input.value=typeof value==='string'?value:'';}
 $('#sheetYear').textContent=(current.fields.date||'2026').slice(0,4);$('#finishBtn').textContent=current.status==='complete'?'Reopen visit':'Finish visit';sources();state(unsavedVisits.has(current.id)?'Not saved · recovery copy needed':native?'Saved on iPad':'Saved on this device');$('#recoveryActions').hidden=!unsavedVisits.has(current.id);for(const phase of ['arrival','departure','additional'])$(`#${phase}PhotoStatus`).textContent='';photoRendering=renderPhotos();photoRendering.catch(()=>notice('Unable to load photo attachments.',true));}
function collect(){const values={};for(const input of form.querySelectorAll('[name]')){if(input.type==='checkbox')values[input.name]=input.checked;else if(input.type==='radio'){if(input.checked)values[input.name]=input.value;}else values[input.name]=input.value;}
 current.fields=values;current.updated=new Date(Math.max(Date.now(),Date.parse(current.updated)+1)).toISOString();current.pending=false;return structuredClone(current);}
async function save(){
 if(!current)return;
 clearTimeout(saveTimer);saveTimer=undefined;const snapshot=collect(),sequence=++saveSequence;unsavedVisits.set(snapshot.id,snapshot);state('Saving…');
 const job=saveChain.catch(()=>{}).then(()=>putVisit(snapshot));saveChain=job;
 try{await job;if(unsavedVisits.get(snapshot.id)?.updated===snapshot.updated)unsavedVisits.delete(snapshot.id);if(sequence===saveSequence){saveError=false;state(native?'Saved on iPad':'Saved on this device');$('#recoveryActions').hidden=true;}}
 catch(error){if(sequence===saveSequence){saveError=true;state('Not saved · retry or export');$('#recoveryActions').hidden=false;notice(`Save failed: ${error.message}. Your current entries remain open. Retry saving or export a recovery copy.`,true);}throw error;}
}
function scheduleSave(){clearTimeout(saveTimer);collect();saveTimer=setTimeout(()=>save().catch(()=>{}),250);state('Unsaved changes…');}
async function mergedVisits(){let visits=[];try{visits=await allVisits();}catch(error){if(!unsavedVisits.size)throw error;}const merged=new Map(visits.map(v=>[v.id,v]));for(const [id,v] of unsavedVisits)merged.set(id,structuredClone(v));return [...merged.values()].sort((a,b)=>b.updated.localeCompare(a.updated));}
async function preserveBeforeSwitch(){if(!current)return;try{await save();}catch{notice('This visit remains open in recovery memory. Export a recovery copy before closing the app.',true);}}
$('#retrySaveBtn').onclick=()=>save().catch(()=>{});
$('#recoveryExportBtn').onclick=()=>exportBackup(true);
window.addEventListener('beforeunload',event=>{if(unsavedVisits.size||saveTimer){event.preventDefault();event.returnValue='';}});
form.addEventListener('submit',event=>event.preventDefault());
form.addEventListener('input',event=>{const key=event.target.name;if(!key)return;if(photoBusy){collect();return;}if(current.sources[key]){current.sources[key].edited=true;sources();}scheduleSave();});
for(const button of document.querySelectorAll('.close'))button.onclick=()=>button.closest('dialog').close();
function openSheet(visit){document.body.dataset.page='sheet';load(visit);scrollTo({top:0});}
async function beginNewVisit(){await preserveBeforeSwitch();const v=newVisit();try{await putVisit(v);}catch(error){unsavedVisits.set(v.id,v);notice(`New visit is open but not saved: ${error.message}. Export a recovery copy.`,true);}openSheet(v);}
$('#newBtn').onclick=()=>beginNewVisit().catch(error=>homeNotice(error.message));
$('#newSheetBtn').onclick=()=>beginNewVisit().catch(error=>notice(error.message,true));
$('#helpBtn').onclick=()=>$('#helpDialog').showModal();
$('#importBtn').onclick=()=>{$('#importDialog').showModal();};
$('#pasteBtn').onclick=()=>{$('#pasteData').value='';$('#pasteDialog').showModal();};
function visitDate(value){if(!value)return 'No date';const [year,month,day]=value.split('-').map(Number);return new Date(year,month-1,day).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});}
function homeNotice(message){$('#homeNotice').textContent=message;$('#homeNotice').hidden=!message;}
function renderHome(){
 const query=$('#visitSearch').value.trim().toLocaleLowerCase(),status=$('#visitStatus').value,color=$('#visitColorFilter').value;
 const eligible=homeVisits.filter(v=>!!v.archived===showArchived);
 const visits=eligible.filter(v=>{
  if(status!=='all'&&v.status!==status)return false;
  if(color!=='all'&&(v.color||'none')!==color)return false;
  const searchable=[v.fields.siteName,v.fields.siteId,v.fields.date,visitDate(v.fields.date),v.fields.technicians,v.fields.ticket,v.fields.notes].filter(Boolean).join(' ').toLocaleLowerCase();
  return !query||searchable.includes(query);
 }).sort((a,b)=>(b.fields.date||'').localeCompare(a.fields.date||'')||b.updated.localeCompare(a.updated));
 $('#homeTitle').textContent=showArchived?'Archived visits':'Visits';
 $('#archivedVisitsBtn').textContent=showArchived?'Show current visits':'Archived visits';
 $('#visitCount').textContent=`${visits.length}${visits.length!==eligible.length?` of ${eligible.length}`:''} visit${(visits.length!==eligible.length?eligible.length:visits.length)===1?'':'s'}`;
 $('#visitList').innerHTML=visits.length?`<ul class="visit-list">${visits.map(v=>`<li class="visit-item" style="--visit-color:${visitColor(v).hex}"><button class="visit-color" data-color-visit="${e(v.id)}" aria-label="Change color for ${e(v.fields.siteName||'Unnamed station')}" title="${visitColor(v).label} · Change color"><span aria-hidden="true"></span></button><button class="visit-row" data-visit="${e(v.id)}"><span><strong>${e(v.fields.siteName||'Unnamed station')}${v.fields.siteId?` · ${e(v.fields.siteId)}`:''}</strong><span class="visit-meta">${e(visitDate(v.fields.date))}${v.fields.technicians?` · ${e(v.fields.technicians)}`:''}</span></span><span class="visit-trailing"><span class="visit-status${unsavedVisits.has(v.id)?' needs-save':v.status==='complete'?' completed':''}">${unsavedVisits.has(v.id)?'Needs saving':v.status==='complete'?'Completed':'In progress'}</span><span class="visit-arrow" aria-hidden="true">›</span></span></button></li>`).join('')}</ul>`:`<p class="empty-visits">${eligible.length?'No visits match these filters.':showArchived?'No archived visits.':'No visits yet. Tap + to start your first visit.'}</p>`;
 for(const button of $('#visitList').querySelectorAll('[data-visit]'))button.onclick=async()=>{
  button.disabled=true;
  try{await preserveBeforeSwitch();const visit=unsavedVisits.get(button.dataset.visit)??await getVisit(button.dataset.visit);if(!visit)throw Error('This visit could not be found.');if(visit.archived){delete visit.archived;await putVisit(visit);}openSheet(visit);}
  catch(error){homeNotice(`Unable to open visit: ${error.message}`);}finally{button.disabled=false;}
 };
 for(const button of $('#visitList').querySelectorAll('[data-color-visit]'))button.onclick=()=>{
  colorVisitId=button.dataset.colorVisit;const visit=homeVisits.find(v=>v.id===colorVisitId);
  $('#colorVisitName').textContent=visit.fields.siteName||'Unnamed station';
  $('#colorChoices').innerHTML=Object.entries(visitColors).map(([key,value])=>`<button data-color="${key}" aria-pressed="${(visit.color||'none')===key}"><span style="background:${value.hex}" aria-hidden="true"></span>${value.label}</button>`).join('');
  for(const choice of $('#colorChoices').querySelectorAll('button'))choice.onclick=()=>changeVisitColor(choice.dataset.color);
  $('#colorDialog').showModal();
 };
 homeNotice(unsavedVisits.size?`${unsavedVisits.size} visit${unsavedVisits.size===1?' needs':'s need'} saving. Open the visit to retry or save a recovery copy before closing the app.`:'');
}
async function showVisits(){await preserveBeforeSwitch();document.body.dataset.page='home';homeVisits=await mergedVisits();renderHome();scrollTo({top:0});}
$('#visitSearch').oninput=renderHome;
$('#visitStatus').onchange=renderHome;
$('#visitColorFilter').onchange=renderHome;
async function changeVisitColor(color){
 const id=colorVisitId;$('#colorDialog').close();
 try{
  await saveChain.catch(()=>{});const visit=structuredClone(unsavedVisits.get(id)??await getVisit(id));if(!visit)throw Error('This visit could not be found.');
  visit.color=color;visit.updated=new Date(Math.max(Date.now(),Date.parse(visit.updated)+1)).toISOString();
  try{await putVisit(visit);unsavedVisits.delete(id);}catch(error){unsavedVisits.set(id,visit);throw error;}finally{if(current?.id===id)current=visit;homeVisits=homeVisits.map(v=>v.id===id?visit:v);renderHome();}
 }catch(error){homeNotice(`Color could not save: ${error.message}. Open this visit to retry or save a recovery copy.`);}
}
$('#archivedVisitsBtn').onclick=()=>{showArchived=!showArchived;renderHome();};
$('#visitsBtn').onclick=()=>showVisits().catch(error=>homeNotice(`Unable to list visits: ${error.message}`));
$('.brand').onclick=event=>{event.preventDefault();showVisits().catch(error=>homeNotice(error.message));};
async function download(data,filename,mime='application/json'){
 if(native){
  const id=crypto.randomUUID();
  await new Promise((resolve,reject)=>{nativeRequests.set(id,{resolve,reject});let timer=setTimeout(()=>{nativeRequests.delete(id);reject(Error('Backup export timed out.'));},120000);const finish=resolve;nativeRequests.set(id,{resolve:value=>{clearTimeout(timer);finish(value)},reject:error=>{clearTimeout(timer);reject(error)}});
   const bridge=window.webkit.messageHandlers.fieldNotes;bridge.postMessage({action:'exportStart',id,filename});
   const bytes=new TextEncoder().encode(data);for(let offset=0;offset<bytes.length;offset+=196608){const chunk=bytes.subarray(offset,offset+196608);let binary='';for(let i=0;i<chunk.length;i+=8192)binary+=String.fromCharCode(...chunk.subarray(i,i+8192));bridge.postMessage({action:'exportChunk',id,data:btoa(binary)});}bridge.postMessage({action:'exportFinish',id});
  });return;
 }
 const url=URL.createObjectURL(new Blob([data],{type:mime}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function exportBackup(currentOnly=false){
 const button=$(currentOnly?'#exportVisitBtn':'#exportBtn');button.disabled=true;
 try{
  // Export the current form even when saving failed. Never put rescue behind a save.
  await save().catch(()=>{});const active=structuredClone(current);
  if(native&&!unsavedVisits.size){const result=await nativeBackup(active,currentOnly);notice(`Backup saved in Files → On My iPad → Field Notes (${result.visits} visits, ${result.photos} photos).`);return;}
  if(native&&unsavedVisits.size===1&&unsavedVisits.has(active.id)){try{const result=await nativeBackup(active,currentOnly);notice(`Recovery backup saved with your current entries (${result.visits} visits, ${result.photos} photos).`);return;}catch{}}
  const visits=currentOnly?[active]:await mergedVisits(),photos=[];
  for(const visit of visits)for(const meta of visit.photos??[]){const photo=await getPhoto(meta.id);if(!photo)throw Error('A photo could not be read.');photos.push(photo);}
  const data=JSON.stringify({format:'FieldNotesBackup',schemaVersion:2,exportedAt:new Date().toISOString(),visits,photos});
  if(new Blob([data]).size>MAX_BACKUP_BYTES)throw Error('This browser backup is too large. Export individual visits.');
  await download(data,`field-notes-${currentOnly?'visit-':''}${new Date().toISOString().slice(0,10)}.json`);
  if(!currentOnly){try{localStorage.setItem('field-notes-last-backup',new Date().toISOString());}catch{}backupReminder();}
  notice('Backup prepared with current entries and photos. Save it in Files to keep a separate copy.');
 }catch(error){
  // Last-resort readable recovery preserves form text without touching the database.
  try{const visit=collect();await download(JSON.stringify({format:'FieldNotesTextRecovery',schemaVersion:1,exportedAt:new Date().toISOString(),visit,warning:'Text and photo captions only. Photo files remain in the notebook; this is not a complete photo backup.'},null,2),`Field-Notes-Text-Recovery-${visit.id}.json`);notice(`A text recovery copy was prepared. The full photo backup failed: ${error.message}`,true);}
  catch(recoveryError){notice(`Export failed: ${recoveryError.message}. Keep the app open; your current entries are still here.`,true);}
 }finally{button.disabled=false;}
}
$('#exportBtn').onclick=()=>exportBackup();
$('#exportVisitBtn').onclick=()=>exportBackup(true);
$('#backupFile').onchange=async event=>{try{if(photoBusy)throw Error('Wait for the photo save to finish.');const file=event.target.files[0];if(!file)return;if(file.size>MAX_BACKUP_BYTES)throw Error('Choose a backup smaller than 128 MB.');const backup=JSON.parse(await file.text());const restored=prepareRestore(backup,new Set((await allVisits()).map(v=>v.id)));await commitVisits(restored.visits,restored.photos);showArchived=false;await showVisits();homeNotice(`Backup restored: ${restored.visits.length} visits and ${restored.photos.length} photos. Existing visits were kept.`);}catch(err){homeNotice(err.message)}finally{event.target.value='';}};
async function preparePrint(){await save().catch(()=>{});collect();await photoRendering;
 // Print text as flowing paragraphs: fixed-height textareas clip long notes.
 for(const input of form.querySelectorAll('textarea')){let text=input.nextElementSibling;if(!text?.classList.contains('print-value')){text=document.createElement('p');text.className='print-value';input.after(text);}text.textContent=input.value||'—';}
 const pictures=Array.from(document.querySelectorAll('.photo-grid img')).filter(img=>img.hasAttribute('src'));for(const img of pictures)img.loading='eager';await Promise.all(pictures.map(img=>img.decode()));}
$('#printBtn').onclick=async()=>{try{await preparePrint();if(native)window.webkit.messageHandlers.fieldNotes.postMessage({action:'print'});else window.print();}catch(err){notice(`Unable to print: ${err.message}`,true)}};
$('#pdfBtn').onclick=async()=>{const button=$('#pdfBtn');button.disabled=true;try{await preparePrint();if(!native){notice('Choose Save as PDF in the print screen. The iPad app saves directly to Files.');window.print();return;}const id=crypto.randomUUID(),station=(current.fields.siteName||'Visit').replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,60);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{nativeRequests.delete(id);reject(Error('PDF creation timed out.'));},60000);nativeRequests.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});window.webkit.messageHandlers.fieldNotes.postMessage({action:'pdf',id,filename:`Field-Notes-${station}-${current.fields.date||'undated'}-${id.slice(0,8)}.pdf`});});notice('PDF saved in Files → On My iPad → Field Notes. The Files screen lets you save another copy.');}catch(err){notice(`Unable to save PDF: ${err.message}`,true)}finally{button.disabled=false}};
$('#finishBtn').onclick=async()=>{try{if(photoBusy){notice('Wait for your photos to finish saving.',true);return;}if(current.status==='complete'){current.status='draft';await save();$('#finishBtn').textContent='Finish visit';return;}if(!form.elements.siteName.value.trim()||!form.elements.date.value||!form.elements.technicians.value.trim()){notice('Enter the site name, date, and technician before finishing.',true);return;}
 if(form.elements.maintenance.value==='yes'&&(!form.elements.maintenanceOn.value||!form.elements.maintenanceOff.value)){notice('Record maintenance mode time on and time off before finishing.',true);return;}
 const missing=['arrival','departure'].filter(phase=>!current.photos.some(p=>p.phase===phase));if(missing.length){notice(`Add at least one ${missing.join(' and ')} photo before finishing this visit.`,true);document.getElementById(`${missing[0]}Photos`).scrollIntoView({behavior:'smooth',block:'start'});return;}
 current.status='complete';if(!form.elements.timeOut.value){const d=new Date();form.elements.timeOut.value=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}await save();$('#finishBtn').textContent='Reopen visit';notice('Visit finished. Export a backup or save a PDF for your station records.');}catch(error){current.status='draft';$('#finishBtn').textContent='Finish visit';notice(`Visit is still open: ${error.message}. Retry or export a recovery copy.`,true);}};
function stage(text,source){try{importData=parseStationData(text,source);$('#importReview').hidden=false;$('#confirmSource').checked=false;$('#overwrite').checked=false;$('#importMeta').textContent=`Station: ${importData.station||'Not provided — confirm manually'}\n${importData.model} ${importData.serial?`· Serial ${importData.serial}`:''} · Table: ${importData.table||'Not provided'}\nLatest record: ${importData.timestamp} [logger clock; time zone not assumed]\nSource: ${source}`;
 const station=current.fields.siteName?.trim();$('#importStatus').textContent=station&&importData.station&&station.toLowerCase()!==importData.station.trim().toLowerCase()?`Check station identity: your sheet says “${station}”; the file says “${importData.station}”.`:'';
 $('#mappingRows').innerHTML=readingTargets.map(t=>{const selected=suggestColumn(t,importData.columns);return `<div class="mapping-row" data-target="${t.key}"><strong>${e(t.label)}<small>Sheet units: ${e(t.unit)}</small></strong><select aria-label="${e(t.label)} source column"><option value="-1">Leave blank / manual</option>${importData.columns.map((c,i)=>`<option value="${i}" ${i===selected?'selected':''}>${e(c.name)} [${e(c.unit||'units missing')}] · ${e(c.process||'process unknown')}</option>`).join('')}</select><div><input class="source-unit" aria-label="${e(t.label)} source units" placeholder="Source units"><small class="import-value"></small></div></div>`}).join('');
 for(const row of $('#mappingRows').children){row.querySelector('select').onchange=()=>updateRow(row,true);row.querySelector('input').oninput=()=>updateRow(row,false);updateRow(row,true);}$('#importDialog').showModal();
 }catch(err){$('#importStatus').textContent=err.message;$('#importReview').hidden=true;importData=null;}}
function updateRow(row,resetUnit){const col=importData.columns[Number(row.querySelector('select').value)],target=readingTargets.find(t=>t.key===row.dataset.target),unit=row.querySelector('input');if(resetUnit)unit.value=col?.unit??'';unit.disabled=!col;const preview=row.querySelector('small.import-value');if(!col){preview.textContent='';return;}try{preview.textContent=`${col.value} → ${convertReading(col.value,unit.value,target.unit)} ${target.unit}`;}catch(err){preview.textContent=`${col.value} · ${err.message}`;}}
$('#dataFile').onchange=async event=>{try{const f=event.target.files[0];if(f){if(f.size>5_000_000)throw Error('Choose a text export smaller than 5 MB.');stage(await f.text(),f.name);}}catch(err){$('#importStatus').textContent=err.message}finally{event.target.value='';}};
$('#parsePaste').onclick=()=>{$('#pasteDialog').close();stage($('#pasteData').value,'Pasted station data');};
$('#applyImport').onclick=async()=>{try{
 if(!importData||!$('#confirmSource').checked){$('#importStatus').textContent='Confirm the station and logger timestamp first.';return;}
 const changes=[];try{for(const row of $('#mappingRows').children){const col=importData.columns[Number(row.querySelector('select').value)];if(!col)continue;const target=readingTargets.find(t=>t.key===row.dataset.target),input=form.elements.namedItem(target.key);if(input.value.trim()&&!$('#overwrite').checked)continue;const unit=row.querySelector('input').value;const value=convertReading(col.value,unit,target.unit);changes.push({target,col,unit,value,input});}}catch(err){$('#importStatus').textContent=`No values applied: ${err.message}`;return;}
 if(!changes.length){$('#importStatus').textContent='No selected blank fields to fill. Choose a source column or enable replacing existing values.';return;}
 const at=new Date().toISOString();for(const {target,col,unit,value,input} of changes){if(current.sources[target.key])current.history.push({field:target.key,...current.sources[target.key]});input.value=value;current.sources[target.key]={station:importData.station,table:importData.table,model:importData.model,serial:importData.serial,column:col.name,unit,targetUnit:target.unit,value,rawValue:col.value,process:col.process,timestamp:importData.timestamp,source:importData.source,importedAt:at,edited:false};}
 if(!form.elements.siteName.value.trim()&&importData.station)form.elements.siteName.value=importData.station;sources();await save();$('#importDialog').close();notice(`${changes.length} readings filled from ${importData.timestamp} [logger clock]. Work checks and field tests remain for you to complete.`);
}catch(error){notice(`Readings remain on the sheet but could not save: ${error.message}`,true);}};

let nativeRequests=new Map();
window.fieldNotesNativeReply=(id,text,error)=>{const p=nativeRequests.get(id);if(!p)return;nativeRequests.delete(id);if(error)p.reject(Error(error));else p.resolve(text);};
window.fieldNotesImport=async(text,name)=>{try{if(!current)await beginNewVisit();else document.body.dataset.page='sheet';stage(text,name??'LoggerLink file');}catch(error){homeNotice(error.message);}};
$('#liveBtn').onclick=async()=>{
 const button=$('#liveBtn');button.disabled=true;$('#importStatus').textContent='Reading station…';
 try{const base=new URL($('#stationUrl').value);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('Enter only the station origin, for example http://192.168.1.10.');
 if(!native&&base.protocol!=='https:')throw Error('This web app cannot read an HTTP modem from an HTTPS page. Use a LoggerLink file, or install the native app.');
 const table=$('#stationTable').value.trim();if(!/^[a-zA-Z0-9_]+$/.test(table))throw Error('Enter a valid data table name.');
 base.search=new URLSearchParams({command:'DataQuery',uri:`dl:${table}`,mode:'most-recent',p1:'1',format:'json'}).toString();const username=$('#stationUser').value,password=$('#stationPassword').value;
 let text;if(native){text=await new Promise((resolve,reject)=>{const id=crypto.randomUUID();nativeRequests.set(id,{resolve,reject});window.webkit.messageHandlers.fieldNotes.postMessage({action:'read',id,url:base.href,username,password});setTimeout(()=>{if(nativeRequests.has(id)){nativeRequests.delete(id);reject(Error('Station read timed out.'))}},20000);});}
 else{const headers={};if(username||password)headers.Authorization='Basic '+btoa(unescape(encodeURIComponent(username+':'+password)));const res=await fetch(base,{headers,signal:AbortSignal.timeout(15000),cache:'no-store'});if(!res.ok)throw Error(`Station returned HTTP ${res.status}. Check its web access and credentials.`);text=await res.text();}
 stage(text,`Station HTTP read: ${base.origin} · ${table}`);
 }catch(err){$('#importStatus').textContent=err.message==='Failed to fetch'?'Station could not be reached. Check modem routing, logger web server, TLS, and browser cross-origin permission; use a LoggerLink data file meanwhile.':err.message;}finally{$('#stationPassword').value='';button.disabled=false;}
};

async function imageAttachment(file,phase){
 if(!file.type.startsWith('image/')||file.size>30_000_000)throw Error('Choose an image smaller than 30 MB.');
 const url=URL.createObjectURL(file);try{const img=new Image();img.src=url;await img.decode();const scale=Math.min(1,1920/Math.max(img.naturalWidth,img.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);let dataUrl=canvas.toDataURL('image/jpeg',.82);if(dataUrl.length>1_500_000)dataUrl=canvas.toDataURL('image/jpeg',.6);if(dataUrl.length>1_500_000)throw Error('This image is too large to attach. Choose a smaller photo.');const id=crypto.randomUUID();return {meta:{id,phase,name:file.name.slice(0,300),caption:'',attachedAt:new Date().toISOString(),width:canvas.width,height:canvas.height},bytes:{id,visitId:current.id,dataUrl}};}catch(err){if(err.name==='EncodingError')throw Error('This image format could not be opened. Choose a JPEG or PNG.');throw err;}finally{URL.revokeObjectURL(url);}
}
function setPhotoBusy(busy){photoBusy=busy;for(const control of document.querySelectorAll('#newBtn,#newSheetBtn,#visitsBtn,#finishBtn,#exportBtn,#exportVisitBtn,#importBtn,#printBtn,#pdfBtn,#sheet input,#sheet textarea,[data-photo-phase],.photo-remove,#backupFile'))control.disabled=busy;}
let photoRenderVersion=0;
async function renderPhotos(){
 const version=++photoRenderVersion;const visitId=current.id;for(const phase of ['arrival','departure','additional']){const entries=current.photos.filter(p=>p.phase===phase),grid=$(`#${phase}PhotoGrid`);grid.replaceChildren();$(`#${phase}PhotoCount`).textContent=entries.length?`${entries.length} photo${entries.length===1?'':'s'}`:'No photos yet';
  for(const [photoIndex,meta] of entries.entries()){const bytes=await getPhoto(meta.id);if(current.id!==visitId||version!==photoRenderVersion)return;const card=document.createElement('article');card.className='photo-card';card.innerHTML=`<h3 class="photo-print-title">${phase==='arrival'?'Arrival':phase==='departure'?'Departure':'Additional'} photo ${photoIndex+1} of ${entries.length}</h3><button type="button" class="photo-open" aria-label="View ${phase} photo"><img alt="${phase==='arrival'?'Arrival':phase==='departure'?'Departure':'Additional'} photo" loading="lazy"></button><p class="photo-time">Attached ${e(new Date(meta.attachedAt).toLocaleString())}</p><label class="field">Caption<textarea rows="2" maxlength="2000" aria-label="${phase} photo caption" placeholder="What does this picture show?"></textarea></label><button type="button" class="quiet photo-remove">Remove photo</button>`;const img=card.querySelector('img');if(bytes)img.src=bytes.dataUrl;else img.alt='Photo unavailable — restore from backup';const caption=card.querySelector('textarea');caption.value=meta.caption;caption.disabled=photoBusy;caption.oninput=()=>{meta.caption=caption.value;if(photoBusy)collect();else scheduleSave();};card.querySelector('.photo-open').onclick=()=>{if(!bytes)return;$('#photoDialogTitle').textContent=phase==='arrival'?'Arrival photo':phase==='departure'?'Departure photo':'Additional photo';$('#photoFullImage').src=bytes.dataUrl;$('#photoDialogCaption').textContent=meta.caption||meta.name;$('#photoDialog').showModal();};card.querySelector('.photo-remove').onclick=async()=>{if(photoBusy)return;if(!confirm('Remove this photo from the visit? Export a backup first if you want to keep a copy.'))return;setPhotoBusy(true);try{await saveChain.catch(()=>{});const next=collect();next.photos=next.photos.filter(p=>p.id!==meta.id);await commitVisits([next],[],[meta.id]);current=next;await renderPhotos();notice('Photo removed.');}catch(err){notice(`Unable to remove photo: ${err.message}`,true)}finally{setPhotoBusy(false)}};grid.append(card);}
 }
}
for(const input of document.querySelectorAll('[data-photo-phase]'))input.onchange=async()=>{
 const files=Array.from(input.files??[]),phase=input.dataset.photoPhase;if(!files.length||photoBusy)return;setPhotoBusy(true);const status=$(`#${phase}PhotoStatus`);let added=0;
 try{if(current.photos.length+files.length>40)throw Error('Keep each visit to 40 photos or fewer.');for(const file of files){status.textContent=`Saving photo ${added+1} of ${files.length}…`;const attachment=await imageAttachment(file,phase);await saveChain.catch(()=>{});const next=collect();next.photos=[...next.photos,attachment.meta];await commitVisits([next],[attachment.bytes]);current=next;added++;}await save();await renderPhotos();status.textContent=`${added} photo${added===1?'':'s'} saved on this device.`;state(native?'Saved on iPad':'Saved on this device');}catch(err){await renderPhotos().catch(()=>{});status.textContent=`${added?`${added} photos saved. `:''}${err.message}`;notice(`Photo attachment: ${err.message}`,true)}finally{input.value='';setPhotoBusy(false);}
};
function backupReminder(){let last;try{last=localStorage.getItem('field-notes-last-backup');}catch{}$('#backupReminder').textContent=last&&Number.isFinite(Date.parse(last))?`All-visits backup last prepared ${new Date(last).toLocaleString()}. Keep the exported file in Files; newer edits need another backup.`:'Notes and photos stay on this device. Export a backup to Files after each field day.';}
async function init(){backupReminder();try{await initializeStorage();homeVisits=await mergedVisits();renderHome();if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
 }catch(error){homeNotice(`Notebook could not open: ${error.message}. Existing records were kept.`);$('#visitCount').textContent='Notebook unavailable';}}
for(const element of document.querySelectorAll('button,input,textarea,select'))element.disabled=true;
await init();
for(const element of document.querySelectorAll('button,input,textarea,select'))element.disabled=false;
if(document.modelContext?.registerTool){try{document.modelContext.registerTool({name:'read_current_field_visit',title:'Read field visit',description:'Read the current field sheet, status, and imported reading sources.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input){if(!input||Object.keys(input).length)throw Error('Expected an empty object.');return current?structuredClone({id:current.id,status:current.status,fields:current.fields,sources:current.sources}):{page:'visits',visitCount:homeVisits.filter(v=>!v.archived).length};}});}catch{}}
window.dispatchEvent(new Event('field-notes-ready'));
if(native)window.webkit.messageHandlers.fieldNotes.postMessage({action:'ready'});

$('#publishTeamBtn').onclick=async()=>{const button=$('#publishTeamBtn');button.disabled=true;try{if(!hasSession())throw Error('Sign in at the Fleet workspace, then return here to publish. Your local visit stays saved.');await save();const visit=collect();if(visit.status!=='complete')throw Error('Finish this visit before publishing.');await request('visits',{method:'POST',body:JSON.stringify({visit})});notice('Visit published to the team. Photos remain on this device; share the PDF in Teams.');}catch(error){notice(error.message,true);}finally{button.disabled=false;}};
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});

const planDialog=document.createElement('dialog');planDialog.innerHTML='<h2>Prepare a field visit</h2><pre id="plan-preview" style="white-space:pre-wrap"></pre><p>Review the station and planned checks. This creates a new visit without filling sensor readings or marking work done.</p><div class="actions"><button id="plan-cancel">Cancel</button><button id="plan-apply" class="primary">Create visit from plan</button></div>';document.body.append(planDialog);
let stagedPlan;
function reviewPlan(value){stagedPlan=parseVisitPlan(value);planDialog.querySelector('#plan-preview').textContent=[stagedPlan.stationName+' ('+stagedPlan.stationId+')',stagedPlan.reason,...stagedPlan.plannedChecks].join('\n');planDialog.showModal();}
planDialog.querySelector('#plan-cancel').onclick=()=>planDialog.close();
planDialog.querySelector('#plan-apply').onclick=async()=>{try{await preserveBeforeSwitch();const v=applyVisitPlan(newVisit(),stagedPlan);v.fields.timeIn='';await putVisit(v);openSheet(v);planDialog.close();notice('Visit plan saved. Record measurements and work during the visit.');}catch(error){notice(error.message,true);}};
const planFile=document.createElement('label');planFile.className='file-button quiet';planFile.textContent='Import visit plan';const planInput=document.createElement('input');planInput.type='file';planInput.accept='.json';planInput.style.display='none';planFile.append(planInput);document.querySelector('.home-tools')?.append(planFile);
planInput.onchange=async()=>{try{const file=planInput.files[0];if(!file)return;if(file.size>8000000)throw Error('Choose a visit-plan file smaller than 8 MB.');reviewPlan(JSON.parse(await file.text()));}catch(error){notice(error.message,true);}finally{planInput.value='';}};
const caseId=new URLSearchParams(location.search).get('case');if(caseId&&/^[a-zA-Z0-9-]{1,100}$/.test(caseId)){history.replaceState(null,'',location.pathname);request('records/'+caseId+'/handoff').then(reviewPlan).catch(error=>notice('Unable to open visit plan: '+error.message,true));}
