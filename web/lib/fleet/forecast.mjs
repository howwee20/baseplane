// NWS gridpoint forecasts and task-weather evaluation. Missing fields are unknown, never zero or safe.
// Generic forecasts cannot certify lightning absence or field safety; thresholds are provisional until adopted.
import {sunTimes,localDate,ZONE} from './time.mjs';
export const FORECAST_VERSION='forecast-v1';
export const SAFETY_NOTE='Generic forecasts cannot certify lightning absence or field safety. MSU practice and on-site judgement govern work.';
const FIELDS={temperature:'temperature',windSpeed:'windSpeed',windGust:'windGust',probabilityOfPrecipitation:'pop',quantitativePrecipitation:'qpf',probabilityOfThunder:'thunder',skyCover:'sky',weather:'weather'};
const UNIT={'wmoUnit:degC':v=>v,'wmoUnit:degF':v=>(v-32)*5/9,'wmoUnit:km_h-1':v=>v/3.6,'wmoUnit:m_s-1':v=>v,'wmoUnit:percent':v=>v,'wmoUnit:mm':v=>v,'wmoUnit:m':v=>v*1000};
const EXPECTED_UNIT={temperature:['wmoUnit:degC','wmoUnit:degF'],windSpeed:['wmoUnit:km_h-1','wmoUnit:m_s-1'],windGust:['wmoUnit:km_h-1','wmoUnit:m_s-1'],pop:['wmoUnit:percent'],qpf:['wmoUnit:mm','wmoUnit:m'],thunder:['wmoUnit:percent',undefined],sky:['wmoUnit:percent']};

// Provisional defaults (not team-adopted). Speeds m/s, temperatures °C, precipitation mm over the task window.
export const TASK_CLASSES={
 electronics:{label:'Electronics / logger work',rules:{maxPop:40,maxQpfMm:0.5,maxGustMs:15.6,maxWindMs:11,minTempC:-15,maxTempC:35,maxThunderPct:10,daylight:true,blockingAlerts:['Severe Thunderstorm Warning','Tornado Warning','Winter Storm Warning','Blizzard Warning','Ice Storm Warning','Flood Warning','Flash Flood Warning']}},
 exposed:{label:'Exposed / tower or climbing work',rules:{maxPop:30,maxQpfMm:0.2,maxGustMs:11.2,maxWindMs:8.9,minTempC:-10,maxTempC:32,maxThunderPct:5,daylight:true,blockingAlerts:['Severe Thunderstorm Warning','Severe Thunderstorm Watch','Tornado Warning','Tornado Watch','Wind Advisory','High Wind Warning','Winter Storm Warning','Blizzard Warning','Ice Storm Warning','Winter Weather Advisory']}},
 inspection:{label:'Simple inspection',rules:{maxPop:70,maxQpfMm:5,maxGustMs:20,maxWindMs:15,minTempC:-20,maxTempC:38,maxThunderPct:20,daylight:false,blockingAlerts:['Severe Thunderstorm Warning','Tornado Warning','Blizzard Warning','Ice Storm Warning','Flash Flood Warning']}}
};
export function validateRules(input={}){
 const out={};
 for(const [cls,def] of Object.entries(TASK_CLASSES)){
  const r={...def.rules,...(input[cls]||{})},num=(k,lo,hi)=>{if(r[k]!==null&&!(Number.isFinite(r[k])&&r[k]>=lo&&r[k]<=hi))throw Error(`${def.label}: ${k} must be between ${lo} and ${hi}.`);};
  num('maxPop',0,100);num('maxQpfMm',0,100);num('maxGustMs',0,60);num('maxWindMs',0,60);num('minTempC',-50,30);num('maxTempC',0,50);num('maxThunderPct',0,100);
  out[cls]={...r,daylight:!!r.daylight,blockingAlerts:Array.isArray(r.blockingAlerts)?r.blockingAlerts.filter(x=>typeof x==='string').slice(0,40).map(x=>x.slice(0,80)):[],adopted:input[cls]?.adopted===true,adoptedBy:input[cls]?.adopted===true?String(input[cls].adoptedBy||'').slice(0,100):null};
 }
 return out;
}
// ISO 8601 durations used by NWS (P4DT5H, PT1H, PT30M).
export function durationMs(d){const m=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d||'');return m?((+m[1]||0)*24*60+(+m[2]||0)*60+(+m[3]||0))*60000:null;}
export function interval(validTime){const [start,dur]=String(validTime||'').split('/'),s=Date.parse(start),d=durationMs(dur);return Number.isFinite(s)&&d?{start:s,end:s+d}:null;}

export function parseGridpoints(json,{fetchedAt=new Date().toISOString(),gridId=null}={}){
 const p=json?.properties||{},fields={},warnings=[];
 for(const [src,name] of Object.entries(FIELDS)){
  const layer=p[src];if(!layer||!Array.isArray(layer.values)){continue;}
  if(name==='weather'){fields.weather=layer.values.map(v=>({...interval(v.validTime),value:(Array.isArray(v.value)?v.value:[]).filter(w=>w&&w.weather).map(w=>({coverage:w.coverage||null,weather:w.weather,intensity:w.intensity||null}))})).filter(v=>Number.isFinite(v.start));continue;}
  if(!EXPECTED_UNIT[name].includes(layer.uom)){warnings.push(`${src}: unsupported unit ${layer.uom}; treated as unknown.`);continue;}
  const conv=layer.uom?UNIT[layer.uom]:v=>v;
  fields[name]=layer.values.map(v=>({...interval(v.validTime),value:typeof v.value==='number'&&Number.isFinite(v.value)?conv(v.value):null})).filter(v=>Number.isFinite(v.start)&&v.value!==null);
 }
 const spans=Object.values(fields).flat().filter(v=>Number.isFinite(v.end));
 return {version:FORECAST_VERSION,source:'NWS gridpoint forecast (api.weather.gov)',gridId,updateTime:p.updateTime||null,fetchedAt,validFrom:spans.length?new Date(Math.min(...spans.map(v=>v.start))).toISOString():null,validTo:spans.length?new Date(Math.max(...spans.map(v=>v.end))).toISOString():null,fieldCoverage:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.length?new Date(Math.max(...v.map(x=>x.end))).toISOString():null])),units:{temperature:'°C',windSpeed:'m/s',windGust:'m/s',pop:'%',qpf:'mm',thunder:'%',sky:'%'},fields,warnings};
}
export function parseAlerts(json){
 return (json?.features||[]).map(f=>{const p=f.properties||{};return {id:String(p.id||f.id||'').slice(0,200),event:String(p.event||'').slice(0,120),severity:p.severity||'Unknown',urgency:p.urgency||null,certainty:p.certainty||null,headline:p.headline?String(p.headline).slice(0,300):null,onset:p.onset||p.effective||null,ends:p.ends||null,expires:p.expires||null,ugc:Array.isArray(p.geocode?.UGC)?p.geocode.UGC.filter(x=>typeof x==='string').slice(0,500):[]};}).filter(a=>a.event);
}
export function alertsFor(alerts,{zones=[],startMs,endMs}){
 return (alerts||[]).filter(a=>a.ugc.some(z=>zones.includes(z))).filter(a=>{const s=Date.parse(a.onset||'')||-Infinity,e=Date.parse(a.ends||a.expires||'')||Infinity;return s<endMs&&e>startMs;});
}
// Values over [start,end): max/min of overlapping intervals; QPF prorated by overlap (uniform-rate assumption).
function over(series,start,end){const hits=(series||[]).filter(v=>v.start<end&&v.end>start);const covered=hits.reduce((t,v)=>t+Math.min(end,v.end)-Math.max(start,v.start),0);return {hits,full:covered>=end-start-60000};}
export function evaluateWindow(forecast,{startMs,endMs,taskClass='electronics',rules=validateRules(),lat=null,lon=null,alerts=[],now=Date.now()}){
 const rule=rules[taskClass]||rules.electronics,f=forecast?.fields||{},values={},unknown=[],violations=[],reasons=[];
 const add=(field,ok,value,limit,message)=>{if(!ok)violations.push({field,value,limit,hard:!!rule.adopted,message});};
 if(!forecast||!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)return {status:'unknown',taskClass,adopted:!!rule.adopted,values,unknown:['forecast'],violations,alerts:[],reasons:['No forecast available for this time.'],coverage:'none',stale:true,note:SAFETY_NOTE};
 const maxOf=(k)=>{const o=over(f[k],startMs,endMs);if(!o.full){unknown.push(k);return o.hits.length?Math.max(...o.hits.map(v=>v.value)):null;}return Math.max(...o.hits.map(v=>v.value));};
 const minOf=(k)=>{const o=over(f[k],startMs,endMs);if(!o.full)return null;return Math.min(...o.hits.map(v=>v.value));};
 values.maxTempC=maxOf('temperature');values.minTempC=minOf('temperature');values.maxWindMs=maxOf('windSpeed');values.maxGustMs=maxOf('windGust');values.maxPop=maxOf('pop');values.maxThunderPct=maxOf('thunder');
 const q=over(f.qpf,startMs,endMs);
 if(q.full)values.qpfMm=Math.round(q.hits.reduce((t,v)=>t+v.value*(Math.min(endMs,v.end)-Math.max(startMs,v.start))/(v.end-v.start),0)*100)/100;else{values.qpfMm=null;unknown.push('qpf');}
 const w=over(f.weather,startMs,endMs);values.weather=[...new Set(w.hits.flatMap(v=>v.value.map(x=>[x.coverage,x.intensity,x.weather].filter(Boolean).join(' ').replace(/_/g,' '))))];
 const thunderWords=w.hits.some(v=>v.value.some(x=>/thunder/.test(x.weather)));
 if(values.maxPop!==null&&!unknown.includes('pop'))add('pop',values.maxPop<=rule.maxPop,values.maxPop,rule.maxPop,`Precipitation chance up to ${Math.round(values.maxPop)}% (limit ${rule.maxPop}%).`);
 if(values.qpfMm!==null)add('qpf',values.qpfMm<=rule.maxQpfMm,values.qpfMm,rule.maxQpfMm,`About ${values.qpfMm} mm expected during the task (limit ${rule.maxQpfMm} mm).`);
 if(values.maxGustMs!==null&&!unknown.includes('windGust'))add('windGust',values.maxGustMs<=rule.maxGustMs,values.maxGustMs,rule.maxGustMs,`Gusts to ${values.maxGustMs.toFixed(1)} m/s (limit ${rule.maxGustMs}).`);
 if(values.maxWindMs!==null&&!unknown.includes('windSpeed'))add('windSpeed',values.maxWindMs<=rule.maxWindMs,values.maxWindMs,rule.maxWindMs,`Sustained wind to ${values.maxWindMs.toFixed(1)} m/s (limit ${rule.maxWindMs}).`);
 if(values.minTempC!==null)add('temperature',values.minTempC>=rule.minTempC,values.minTempC,rule.minTempC,`Temperature down to ${values.minTempC.toFixed(0)} °C (limit ${rule.minTempC}).`);
 if(values.maxTempC!==null&&!unknown.includes('temperature'))add('temperature',values.maxTempC<=rule.maxTempC,values.maxTempC,rule.maxTempC,`Temperature up to ${values.maxTempC.toFixed(0)} °C (limit ${rule.maxTempC}).`);
 if(values.maxThunderPct!==null&&!unknown.includes('thunder'))add('thunder',values.maxThunderPct<=rule.maxThunderPct,values.maxThunderPct,rule.maxThunderPct,`Thunder probability up to ${Math.round(values.maxThunderPct)}% (limit ${rule.maxThunderPct}%).`);
 if(thunderWords)violations.push({field:'weather',value:'thunderstorms',limit:'none',hard:!!rule.adopted,message:'Thunderstorms in the forecast weather.'});
 if(rule.daylight&&Number.isFinite(lat)&&Number.isFinite(lon)){
  const s=sunTimes(localDate(startMs,ZONE),lat,lon);values.daylight=s?.sunrise?{sunrise:new Date(s.sunrise).toISOString(),sunset:new Date(s.sunset).toISOString(),ok:startMs>=s.sunrise&&endMs<=s.sunset}:null;
  if(values.daylight&&!values.daylight.ok)violations.push({field:'daylight',value:'outside daylight',limit:'daylight',hard:!!rule.adopted,message:'Task extends outside approximate daylight (sunrise–sunset).'});
 }
 const relevant=(alerts||[]).filter(a=>{const s=Date.parse(a.onset||'')||-Infinity,e=Date.parse(a.ends||a.expires||'')||Infinity;return s<endMs&&e>startMs;});
 for(const a of relevant)if(rule.blockingAlerts.includes(a.event))violations.push({field:'alert',value:a.event,limit:'none',hard:!!rule.adopted,message:`NWS ${a.event} in effect.`});
 const required=['pop','windGust','temperature'],missingRequired=required.filter(k=>unknown.includes(k)),stale=!forecast.updateTime||now-Date.parse(forecast.updateTime)>12*36e5||now-Date.parse(forecast.fetchedAt||0)>6*36e5;
 const coverage=unknown.length===0?'full':['temperature','pop','windSpeed'].every(k=>unknown.includes(k))?'none':'partial';
 let status=violations.some(v=>v.hard)?'blocked':violations.length?'caution':missingRequired.length||coverage==='none'?'unknown':'ok';
 if(stale&&status==='ok')status='unknown';
 for(const v of violations)reasons.push(v.message+(v.hard?' Adopted rule.':' Provisional rule.'));
 if(missingRequired.length)reasons.push(`Unknown in this window: ${missingRequired.map(k=>({pop:'precipitation chance',windGust:'gusts',temperature:'temperature'})[k]).join(', ')}.`);
 if(unknown.includes('qpf')&&!missingRequired.includes('qpf'))reasons.push('Rainfall amount not forecast for this time (NWS amounts cover about 3 days).');
 if(stale)reasons.push('Forecast is stale or its update time is unknown; refresh before departure.');
 if(status==='ok')reasons.push('Within provisional task-weather limits for the full on-site interval.');
 return {status,taskClass,adopted:!!rule.adopted,values,unknown:[...new Set(unknown)],violations,alerts:relevant.map(a=>a.event),reasons,coverage,stale,updateTime:forecast.updateTime,fetchedAt:forecast.fetchedAt,note:SAFETY_NOTE};
}
export function daySummary(forecast,{startMs,endMs}){
 const f=forecast?.fields||{},pick=(k,fn)=>{const o=over(f[k],startMs,endMs);return o.hits.length?fn(...o.hits.map(v=>v.value)):null;};
 const q=over(f.qpf,startMs,endMs);
 return {minTempC:pick('temperature',Math.min),maxTempC:pick('temperature',Math.max),maxPop:pick('pop',Math.max),maxGustMs:pick('windGust',Math.max),maxThunderPct:pick('thunder',Math.max),qpfMm:q.full?Math.round(q.hits.reduce((t,v)=>t+v.value*(Math.min(endMs,v.end)-Math.max(startMs,v.start))/(v.end-v.start),0)*10)/10:null,coverage:over(f.temperature,startMs,endMs).full?'full':over(f.temperature,startMs,endMs).hits.length?'partial':'none'};
}
