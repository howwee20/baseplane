// Expected-sensor profiles. Channels are bootstrapped from Synoptic metadata (period of record) and
// observed coverage, then persisted; a channel that was expected stays expected when it disappears, so the
// loss remains detectable. Team-confirmed rows are never overwritten by inference.
import {parseInstant} from './time.mjs';
export const PROFILE_VERSION='profiles-v1';
export const EXPECTATIONS=['expected','optional','seasonal','provisional','dormant','never-reported','removed','not-expected'];
const CADENCES=[5,10,15,20,30,60,120,180,360,720,1440];
export const PROFILE_DEFAULTS={retiredAfterDays:30,provisionalAfterHours:24};

// 'air_temp_value_1' -> air_temp / set 1; derived values end with 'd' ('dew_point_temperature_value_1d').
export function parseObservationKey(key){
 const m=/^(.+)_value_(\d+)(d?)$/.exec(key);if(!m)return null;
 return {variable:m[1],set:m[2],derived:m[3]==='d',channel:`${m[1]}_${m[2]}`,key};
}
export const observationKey=channel=>{const m=/^(.+)_(\d+)$/.exec(channel);return m?`${m[1]}_value_${m[2]}`:null;};

// Provisional physical-instrument grouping. Unknown mappings stay per-channel and are labelled provisional.
const FAMILIES=[
 [/^wind_(speed|gust|direction)$/,'wind','Wind instrument'],
 [/^(air_temp|relative_humidity)$/,'temp-rh','Temperature/RH probe'],
 [/^precip_accum_/,'rain','Rain gauge'],
 [/^solar_radiation$/,'pyranometer','Pyranometer'],
 [/^net_radiation$/,'net-radiometer','Net radiometer'],
 [/^(soil_temp|soil_moisture)$/,'soil','Soil probe'],
 [/^volt$/,'logger-power','Logger battery voltage'],
 [/^leaf_wet/,'leaf-wetness','Leaf wetness sensor']
];
export function inferredGroup(variable,position){
 const pos=position===null||position===undefined||position===''?'?':String(position);
 for(const [re,id,label] of FAMILIES)if(re.test(variable))return {id:`${id}@${pos}`,label:`${label}${pos==='?'?' (height unknown)':` · ${pos} m`}`};
 return {id:`${variable}@${pos}`,label:`${variable.replace(/_/g,' ')}${pos==='?'?'':` · ${pos} m`}`};
}
const snapCadence=m=>CADENCES.find(c=>c>=m-1)||1440;

// Returns the merged profile rows plus the subset that changed and must be persisted.
export function bootstrapProfile({stationId,meta=null,latest=null,units={},existing=[],now=Date.now(),config={}}){
 const opts={...PROFILE_DEFAULTS,...config},rows=new Map(existing.map(r=>[r.channel,{...r}])),changed=new Set(),nowIso=new Date(now).toISOString();
 const vars=meta?.SENSOR_VARIABLES||latest?.SENSOR_VARIABLES||{},metaChannels=new Map();
 for(const [variable,channels] of Object.entries(vars))for(const [channel,info] of Object.entries(channels||{})){
  if(!/^.+_\d+$/.test(channel))continue;
  metaChannels.set(channel,{variable,position:info?.position??null,start:parseInstant(info?.PERIOD_OF_RECORD?.start),end:parseInstant(info?.PERIOD_OF_RECORD?.end)});
 }
 const observed=new Map();
 for(const [key,v] of Object.entries(latest?.OBSERVATIONS||{})){const k=parseObservationKey(key);if(!k||k.derived)continue;observed.set(k.channel,{...k,value:v?.value,time:parseInstant(v?.date_time)});}
 const newestEnd=Math.max(0,...[...metaChannels.values()].map(c=>c.end||0));
 // Material changes (expectation, cadence, unit, first sighting) persist immediately; last-seen heartbeats every 6 h
 // keep D1 writes bounded (about 1,200 channels are polled every 15 minutes).
 const touch=(row,patch,material=true)=>{for(const [k,v] of Object.entries(patch))if(row[k]!==v){row[k]=v;if(material)changed.add(row.channel);}};
 for(const channel of new Set([...metaChannels.keys(),...observed.keys()])){
  const m=metaChannels.get(channel),o=observed.get(channel),variable=m?.variable||o.variable,numeric=typeof o?.value==='number'&&Number.isFinite(o.value);
  let row=rows.get(channel);
  if(!row){
   let expected,source,note='';
   if(m){
    if(!m.start&&!m.end){expected='never-reported';note='Listed in metadata without a period of record.';}
    else if(m.end&&newestEnd-m.end>opts.retiredAfterDays*864e5){expected='dormant';note=`Last reported ${new Date(m.end).toISOString().slice(0,10)}, more than ${opts.retiredAfterDays} days before the station's other channels. Confirm removed or expected.`;}
    else if(m.start&&now-m.start>=opts.provisionalAfterHours*36e5)expected='expected';
    else {expected='provisional';note='Recently started reporting; becomes expected after sustained coverage.';}
    source='metadata';
   }else{expected='provisional';source='coverage';note='Observed without station metadata.';}
   if(numeric&&['never-reported','dormant'].includes(expected)){expected='provisional';note='Reporting again after metadata listed it as inactive.';}
   const g=inferredGroup(variable,m?.position);
   row={station:stationId,channel,variable,unit:units[variable]||null,position:m?.position??null,sensorGroup:g.id,groupLabel:g.label,groupSource:'inferred',expected,source,cadenceMinutes:null,installed:null,removed:null,seasonal:null,firstSeen:numeric?nowIso:null,lastSeen:numeric?nowIso:null,lastObs:numeric&&o.time?new Date(o.time).toISOString():null,note,revision:null};
   rows.set(channel,row);changed.add(channel);continue;
  }
  if(units[variable]&&row.unit!==units[variable])touch(row,{unit:units[variable]});
  if(numeric){
   const prevObs=parseInstant(row.lastObs);
   if(o.time&&prevObs&&o.time>prevObs){const delta=(o.time-prevObs)/60000;if(delta>=1&&delta<=1440){const c=snapCadence(delta);if(!row.cadenceMinutes||c<row.cadenceMinutes)touch(row,{cadenceMinutes:c});}}
   const heartbeat=!row.lastSeen||now-(parseInstant(row.lastSeen)||0)>=6*36e5;
   if(!row.firstSeen)touch(row,{firstSeen:nowIso});
   touch(row,{lastSeen:nowIso,...(o.time&&(!prevObs||o.time>prevObs)?{lastObs:new Date(o.time).toISOString()}:{})},heartbeat);
   if(row.source!=='team'&&['never-reported','dormant','not-expected'].includes(row.expected))touch(row,{expected:'provisional',note:'Reporting again; becomes expected after sustained coverage.'});
  }
  if(row.source!=='team'&&row.expected==='provisional'){
   const first=parseInstant(row.firstSeen),metaStart=m?.start;
   const covered=Math.min(first??Infinity,metaStart??Infinity);
   if(numeric&&Number.isFinite(covered)&&now-covered>=opts.provisionalAfterHours*36e5)touch(row,{expected:'expected',note:''});
  }
 }
 return {rows:[...rows.values()].sort((a,b)=>a.channel.localeCompare(b.channel)),changed:[...changed].map(c=>rows.get(c))};
}

// Whether a profile row expects data at an instant (installation, removal and season respected).
export function expectedAt(row,now=Date.now()){
 if(!row||row.expected!=='expected'&&row.expected!=='seasonal')return false;
 const installed=parseInstant(row.installed),removed=parseInstant(row.removed);
 if(installed&&now<installed||removed&&now>=removed)return false;
 if(row.expected==='seasonal'){const months=row.seasonal?.months;if(!Array.isArray(months)||!months.length)return false;return months.includes(new Date(now).getUTCMonth()+1);}
 return true;
}
export function notExpectedReason(row,now=Date.now()){
 if(!row)return 'No profile entry.';
 const removed=parseInstant(row.removed),installed=parseInstant(row.installed);
 if(removed&&now>=removed)return 'Removed '+row.removed.slice(0,10)+'.';
 if(installed&&now<installed)return 'Installation date '+row.installed.slice(0,10)+' is in the future.';
 return ({optional:'Optional channel.',seasonal:'Out of season.',provisional:'Provisional: not yet sustained coverage.',dormant:'Dormant at bootstrap; awaiting team confirmation.','never-reported':'Listed in metadata but never reported.',removed:'Marked removed.','not-expected':'Marked not expected.'})[row.expected]||'Not expected.';
}

// Validates a team edit to one profile row.
export function validateProfileEdit(b){
 const out={};
 if(b.expected!==undefined){if(!EXPECTATIONS.includes(b.expected))throw Error('Choose a supported expectation.');out.expected=b.expected;}
 if(b.sensorGroup!==undefined){if(typeof b.sensorGroup!=='string'||!/^[a-z0-9@._?-]{1,80}$/i.test(b.sensorGroup))throw Error('Use a short sensor group identifier.');out.sensorGroup=b.sensorGroup;}
 if(b.groupLabel!==undefined)out.groupLabel=String(b.groupLabel).slice(0,120);
 for(const k of ['installed','removed']){if(b[k]!==undefined){if(b[k]===null||b[k]==='')out[k]=null;else{const t=parseInstant(b[k]);if(t===null)throw Error('Use ISO dates for installation and removal.');out[k]=new Date(t).toISOString();}}}
 if(b.seasonal!==undefined){if(b.seasonal===null)out.seasonal=null;else{const months=b.seasonal?.months;if(!Array.isArray(months)||!months.length||months.some(m=>!Number.isInteger(m)||m<1||m>12))throw Error('Seasonal months must be 1–12.');out.seasonal={months:[...new Set(months)].sort((a,b)=>a-b)};}}
 if(b.cadenceMinutes!==undefined){if(b.cadenceMinutes!==null&&!CADENCES.includes(b.cadenceMinutes))throw Error('Choose a supported cadence.');out.cadenceMinutes=b.cadenceMinutes;}
 if(b.note!==undefined)out.note=String(b.note).slice(0,500);
 if(!Object.keys(out).length)throw Error('No profile changes supplied.');
 return out;
}
