import {validateVisitContent} from '../lib/visits.mjs';
export const depthTemps=[5,10,20,50,100],depthMoistures=[5,10,20,30,50,60,100];
export const MAX_LOGGER_COLUMNS=256;
export const readingTargets=[
 {key:'windSpeed',label:'Wind speed',unit:'m/s',aliases:['WS','WS_ms','WindSpeed','WindSpd','WindSpeed_ms']},
 {key:'windDirection',label:'Wind direction',unit:'°',aliases:['WD','WindDir','WindDirection']},
 {key:'airTemp',label:'Air temperature',unit:'°C',aliases:['AirTC','AirTemp','AT','Temp_C','AirTemp_C']},
 {key:'humidity',label:'Relative humidity',unit:'%',aliases:['RH','RelHum','RelativeHumidity']},
 {key:'solarOpen',label:'Pyranometer · open',unit:'W/m²',aliases:['SlrW','SlrWm2','SolarRad','SolarRadiation']},
 ...depthTemps.map(d=>({key:`soilTemp${d}`,label:`Soil temperature · ${d} cm`,unit:'°C',aliases:[`SoilTC_${d}cm`,`SoilTemp_${d}cm`,`ST_${d}cm`]})),
 ...depthMoistures.map(d=>({key:`soilMoisture${d}`,label:`Soil moisture · ${d} cm`,unit:'%',aliases:[`SoilVWC_${d}cm`,`SoilMoisture_${d}cm`,`SM_${d}cm`]})),
 {key:'batteryVoltage',label:'Battery voltage',unit:'V',aliases:['BattV','BatteryVoltage','BattVolt']},
];
export function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function parseCSV(text){
 const rows=[];let row=[],cell='',quoted=false,cells=0;
 const pushCell=()=>{if(cell.length>4096||++cells>250000)throw Error('Logger export is too large or contains oversized values.');row.push(cell);};
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||cell==='')quoted=!quoted;else cell+=c;}
 else if(c===','&&!quoted){if(row.length>=MAX_LOGGER_COLUMNS-1)throw Error('Choose a logger export with at most 256 columns.');pushCell();cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;pushCell();if(row.some(x=>x.trim())){if(rows.length>=50000)throw Error('Choose an export with at most 50,000 rows.');rows.push(row);}row=[];cell='';}else cell+=c;}
 if(quoted)throw Error('A quoted CSV value is unfinished. Select a complete export.');
 pushCell();if(row.some(x=>x.trim())){if(rows.length>=50000)throw Error('Choose an export with at most 50,000 rows.');rows.push(row);}return rows;
}
function latest(rows,timeFor){
 if(!rows.length)throw Error('No data records found.');
 const times=rows.map(r=>String(timeFor(r)??''));
 if(times.some(t=>!/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(t)))throw Error('A valid logger timestamp is required for every record.');
 return rows.reduce((a,b)=>String(timeFor(a)).replace(' ','T')>String(timeFor(b)).replace(' ','T')?a:b);
}
export function parseStationData(text,source='Station data'){
 if(typeof text!=='string'||text.length>5_000_000)throw Error('Choose a text data export smaller than 5 MB.');
 text=text.replace(/^\uFEFF/,'').trim();if(!text)throw Error('The data file is empty.');
 if(text.startsWith('{')){
 const json=JSON.parse(text),head=json.head;
 if(!head||!Array.isArray(head.fields)||!Array.isArray(json.data))throw Error('Expected Campbell JSON with head.fields and data rows.');
 if(head.fields.length>MAX_LOGGER_COLUMNS)throw Error('Choose a logger export with at most 256 columns.');
 if(json.data.length>50000||head.fields.some(f=>!f||typeof f.name!=='string'||f.name.length>200||String(f.units??'').length>100||String(f.process??'').length>100))throw Error('Logger field labels or row count exceed the import limits.');
 const record=latest(json.data,r=>r.time);if(!Array.isArray(record.vals)||record.vals.length!==head.fields.length)throw Error('The data row does not match its field schema.');
 return {station:String(head.environment?.station_name??''),model:String(head.environment?.model??''),serial:String(head.environment?.serial_no??''),table:String(head.environment?.table_name??''),timestamp:String(record.time),source,columns:head.fields.map((f,i)=>({name:String(f.name),unit:String(f.units??''),process:String(f.process??''),value:record.vals[i]}))};
 }
 const rows=parseCSV(text),toa5=rows[0]?.[0]==='TOA5';
 const names=rows[toa5?1:0];if(names?.some(n=>n.length>200))throw Error('Logger column names must be at most 200 characters.');if(!names||names.length<2)throw Error('Expected TOA5 or comma-separated data with headers.');
 const units=toa5?rows[2]:[],process=toa5?rows[3]:[];
 const ti=names.findIndex(n=>/^(timestamp|time|date_time)$/i.test(n.trim()));if(ti<0)throw Error('No TIMESTAMP column found.');
 const data=rows.slice(toa5?4:1);if(data.some(r=>r.length!==names.length))throw Error('A row does not match the column headers. Use a complete export.');
 const record=latest(data,r=>r[ti]);
 return {station:toa5?rows[0][1]:'',model:toa5?rows[0][2]:'',serial:toa5?rows[0][3]:'',table:toa5?rows[0][7]:'',timestamp:record[ti],source,columns:names.map((n,i)=>({name:n,unit:units?.[i]??'',process:process?.[i]??'',value:record[i]})).filter((_,i)=>i!==ti&&!/^record$/i.test(names[i]))};
}
const normalize=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
export function suggestColumn(target,columns){
 const matches=columns.map((c,i)=>({c,i})).filter(({c})=>target.aliases.some(a=>normalize(a)===normalize(c.name))&&(!c.process||/^(smp|sample)$/i.test(c.process)));
 return matches.length===1?matches[0].i:-1;
}
export function convertReading(value,unit,targetUnit){
 if(value===null||value===undefined||String(value).trim()===''||!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value).trim()))throw Error('Missing or invalid numeric reading.');
 const v=Number(value);if(!Number.isFinite(v)||[6999,7999,9999].includes(Math.abs(v)))throw Error('Missing, invalid, or out-of-range reading.');
 const u=String(unit).toLowerCase().replace(/\s+/g,'').replace(/²/g,'2').replace(/°/g,'');
 const units={ '°C':['c','degc','celsius'], '%':['%','percent','pct'], 'm/s':['m/s','ms-1','msec-1'], '°':['deg','degree','degrees'], 'W/m²':['w/m2','wm-2','w/m^2'], 'V':['v','volt','volts']};
 let n=v;
 if(targetUnit==='°C'&&['f','degf','fahrenheit'].includes(u))n=(v-32)*5/9;
 else if(targetUnit==='%'&&['fraction','m3/m3','m^3/m^3','m3m-3'].includes(u))n=v*100;
 else if(targetUnit==='m/s'&&u==='mph')n=v*.44704;
 else if(targetUnit==='m/s'&&['km/h','kph'].includes(u))n=v/3.6;
 else if(targetUnit==='V'&&u==='mv')n=v/1000;
 else if(!(units[targetUnit]??[]).includes(u))throw Error('Choose the source units before importing.');
 if((targetUnit==='%'&&(n<0||n>100))||(targetUnit==='°'&&(n<0||n>360))||(targetUnit==='m/s'&&n<0)||(targetUnit==='V'&&n<0)||(targetUnit==='°C'&&(n<-100||n>100)))throw Error('Reading outside the expected range.');
 return String(Number(n.toFixed(3)));
}
export function newVisit(){const now=new Date(),local=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString();return {schemaVersion:1,id:crypto.randomUUID(),updated:now.toISOString(),status:'draft',fields:{date:local.slice(0,10),timeIn:local.slice(11,16)},sources:{},history:[],photos:[],pending:false,baseUpdated:null};}
export function validateVisit(v){
 validateVisitContent(v,{local:true});
 if(v.photos!==undefined){if(!Array.isArray(v.photos)||v.photos.length>40)throw Error('Invalid visit photo list.');for(const p of v.photos)validatePhotoMeta(p);if(new Set(v.photos.map(p=>p.id)).size!==v.photos.length)throw Error('Duplicate photo references.');}
 return v;
}


export const MAX_BACKUP_BYTES=128_000_000;
export function validatePhotoMeta(p){if(!p||typeof p.id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(p.id)||!['arrival','departure','additional'].includes(p.phase)||typeof p.name!=='string'||p.name.length>300||typeof p.caption!=='string'||p.caption.length>2000||typeof p.attachedAt!=='string'||!Number.isFinite(Date.parse(p.attachedAt))||!Number.isInteger(p.width)||!Number.isInteger(p.height)||p.width<1||p.height<1||p.width>1920||p.height>1920)throw Error('Invalid photo information.');return p;}
export function validatePhotoBytes(p){if(!p||typeof p.id!=='string'||typeof p.visitId!=='string'||typeof p.dataUrl!=='string'||p.dataUrl.length>1_500_000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(p.dataUrl))throw Error('Invalid photo attachment.');return p;}
export function prepareRestore(backup,existingIds=new Set(),newId=()=>crypto.randomUUID()){
 if(!backup||backup.format!=='FieldNotesBackup'||![1,2].includes(backup.schemaVersion??1)||!Array.isArray(backup.visits)||!Array.isArray(backup.photos??[]))throw Error('Not a Field Notes backup.');
 const bytes=new Map();for(const photo of backup.photos??[]){validatePhotoBytes(photo);if(bytes.has(photo.id))throw Error('Duplicate backup photo.');bytes.set(photo.id,photo);}
 const visits=[],photos=[],seenVisits=new Set(),used=new Set();
 for(const original of backup.visits){validateVisit(original);if(seenVisits.has(original.id))throw Error('Duplicate backup visit.');seenVisits.add(original.id);const v=structuredClone(original);if(existingIds.has(v.id)){v.id=newId();v.updated=new Date().toISOString();delete v.publishedRevision;}existingIds.add(v.id);v.pending=false;v.baseUpdated=null;v.photos??=[];
 for(const meta of v.photos){const data=bytes.get(meta.id);if(!data||data.visitId!==original.id||used.has(meta.id))throw Error('Backup is missing a visit photo or contains inconsistent references.');used.add(meta.id);meta.id=newId();photos.push({...data,id:meta.id,visitId:v.id});}visits.push(v);}
 if(used.size!==bytes.size)throw Error('Backup contains unattached photos.');return {visits,photos};
}
