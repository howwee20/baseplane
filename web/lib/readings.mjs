// Latest-reading presentation shared by the map and the station panel. Raw Synoptic values and units are never
// altered; display conversions only apply when the source unit is the one expected, otherwise the raw unit is shown.
export const MEASURES={
 air_temp:{label:'Temperature',units:['Celsius','C','degC'],to:c=>c*9/5+32,unit:'°F',metric:'°C',digits:1},
 dew_point_temperature:{label:'Dew point',units:['Celsius','C','degC'],to:c=>c*9/5+32,unit:'°F',metric:'°C',digits:1,derived:true},
 relative_humidity:{label:'Humidity',units:['%','percent'],unit:'%',digits:0},
 wind_speed:{label:'Wind',units:['m/s','Meters per second'],to:v=>v*2.23694,unit:'mph',metric:'m/s',digits:1},
 wind_gust:{label:'Gust',units:['m/s','Meters per second'],to:v=>v*2.23694,unit:'mph',metric:'m/s',digits:1},
 wind_direction:{label:'Wind direction',units:['Degrees','degrees'],unit:'°',digits:0},
 precip_accum_one_hour:{label:'Rain · past hour',units:['Millimeters','mm'],to:v=>v/25.4,unit:'in',metric:'mm',digits:2},
 solar_radiation:{label:'Solar radiation',units:['W/m**2','W/m2','Watts per square meter'],unit:'W/m²',digits:0},
 soil_temp:{label:'Soil temperature',units:['Celsius','C','degC'],to:c=>c*9/5+32,unit:'°F',metric:'°C',digits:1},
 soil_moisture:{label:'Soil moisture',units:['%','percent'],unit:'%',digits:0},
 volt:{label:'Battery',units:['volts','Volts','V'],unit:'V',digits:2}
};
// Variables offered as map layers (only those the backend supplies for the network).
export const MAP_VARIABLES=['air_temp','dew_point_temperature','relative_humidity','wind_speed','precip_accum_one_hour'];
const CARDINALS=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
export const cardinal=deg=>Number.isFinite(deg)?CARDINALS[Math.round(((deg%360)+360)%360/22.5)%16]:'';
const num=v=>typeof v==='number'&&Number.isFinite(v);
const fixed=(v,d)=>Number(v.toFixed(d)).toLocaleString('en-US',{minimumFractionDigits:d>1?d:0,maximumFractionDigits:d});
// Primary (lowest-numbered, non-derived unless the measure is derived) channel for a variable.
export function primaryField(station,variable){
 const m=MEASURES[variable];
 return (station?.fields||[]).filter(f=>f.variable===variable&&(m?.derived?true:!f.derived)).sort((a,b)=>a.key.localeCompare(b.key,undefined,{numeric:true}))[0]||null;
}
export function formatValue(variable,value,unit){
 const m=MEASURES[variable];if(!num(value))return null;
 if(m&&m.units.includes(unit))return {text:fixed(m.to?m.to(value):value,m.digits),unit:m.unit,metric:m.to?`${fixed(value,m.digits>1?m.digits:1)} ${m.metric}`:null,converted:m.to?m.to(value):value};
 return {text:fixed(value,2),unit:unit||'',metric:null,converted:value,unexpectedUnit:true};
}
// One reading with its own observation time, QC state and freshness. Flagged or stale values are never presented
// as current: callers show the state next to the value.
export function reading(station,variable,{now=Date.now(),staleMinutes=180,missing=[]}={}){
 const f=primaryField(station,variable),m=MEASURES[variable];if(!f)return null;
 const t=Date.parse(f.time||''),age=Number.isFinite(t)?Math.round((now-t)/60000):null,v=formatValue(variable,f.value,f.unit);
 const channel=f.key.replace(/_value_(\d+)d?$/,'_$1'),flagged=!!f.qc?.length||f.qcStatus==='failed';
 return {variable,label:m?.label||variable,key:f.key,channel,raw:f.value,rawUnit:f.unit,value:v,time:f.time,ageMinutes:age,future:age!==null&&age<-5,flagged,qc:f.qc||[],stale:age!==null&&age>staleMinutes,missing:missing.includes(channel)||!v};
}
export function stationReadings(station,opts={}){
 const out=[];for(const v of Object.keys(MEASURES)){const r=reading(station,v,opts);if(r)out.push(r);}return out;
}
// Value shown on a map marker: only a valid, fresh, unflagged reading. Anything else shows no number.
export function markerReading(station,variable,opts={}){
 const r=reading(station,variable,opts);if(!r||!r.value||r.flagged||r.stale||r.future)return {text:'',reading:r};
 if(variable==='wind_speed'){const d=reading(station,'wind_direction',opts);return {text:Math.round(r.value.converted)+'',reading:r,direction:d&&!d.flagged&&!d.stale&&d.value?d.raw:null};}
 if(variable==='precip_accum_one_hour')return {text:r.value.converted>=0.005?r.value.text:'0',reading:r};
 return {text:Math.round(r.value.converted)+'',reading:r};
}
// Colour scales for weather values (independent of the health shapes drawn on markers).
const ramp=(stops,v)=>{if(!num(v))return '#c9cfc8';if(v<=stops[0][0])return stops[0][1];for(let i=1;i<stops.length;i++)if(v<=stops[i][0]){const [a,ca]=stops[i-1],[b,cb]=stops[i],t=(v-a)/(b-a),h=x=>parseInt(x,16),c=(x,y)=>Math.round(h(x)+(h(y)-h(x))*t).toString(16).padStart(2,'0');return '#'+c(ca.slice(1,3),cb.slice(1,3))+c(ca.slice(3,5),cb.slice(3,5))+c(ca.slice(5,7),cb.slice(5,7));}return stops.at(-1)[1];};
export const SCALES={
 air_temp:[[-10,'#3b4cc0'],[20,'#6788ee'],[40,'#9abbff'],[55,'#c9d7ef'],[65,'#edd1c2'],[80,'#f7a889'],[95,'#e26952']],
 dew_point_temperature:[[0,'#8c6d31'],[30,'#bfa76f'],[45,'#c7e9c0'],[55,'#74c476'],[65,'#238b45'],[75,'#00441b']],
 relative_humidity:[[0,'#f6e8c3'],[40,'#c7eae5'],[70,'#5ab4ac'],[100,'#01665e']],
 wind_speed:[[0,'#f7fcf5'],[5,'#c7e9c0'],[10,'#74c476'],[20,'#31a354'],[30,'#006d2c']],
 precip_accum_one_hour:[[0,'#f7fbff'],[0.01,'#c6dbef'],[0.1,'#6baed6'],[0.3,'#2171b5'],[1,'#08306b']]
};
export const scaleColor=(variable,v)=>ramp(SCALES[variable]||SCALES.air_temp,v);
// Health for markers and panels, from the canonical queue and the latest health assessment.
export function stationHealth(station,ops){
 if(station?.archiveStatus==='INACTIVE')return {code:'inactive',label:'Inactive station'};
 const item=ops?.queue?.find(i=>i.stations?.includes(station.id)&&['P1','P2','P3','P4','QC'].includes(i.effectiveTier));
 const h=ops?.health?.[station.id];
 if(item){
  const t=item.effectiveTier,base={tier:t,incidentId:/^(qc|pm):/.test(item.id)?null:item.id,groupId:item.scope==='group'?item.id:item.groupId||null,confirmed:item.confidence==='confirmed'};
  if(t==='P1'||t==='P2')return {...base,code:'out',label:t==='P1'?'Not reporting · part of a group outage':'Not reporting'};
  if(t==='P3')return {...base,code:'sensor',label:'Several sensors missing'};
  if(t==='P4')return {...base,code:'sensor',label:'One sensor missing'};
  return {...base,code:'qc',label:'Quality check flag to review'};
 }
 if(h?.reporting==='outage-candidate'||h?.reporting==='no-data')return {code:'out',label:'Not reporting'};
 if(h?.reporting==='delayed')return {code:'delayed',label:`Delayed · newest reading ${h.ageMinutes} min old`};
 if(h?.reporting==='maintenance')return {code:'maintenance',label:'Planned maintenance'};
 if(!h&&station?.status==='unknown')return {code:'unknown',label:'No recent readings'};
 return {code:'ok',label:'Reporting'};
}
export const PLAIN_TIER={P1:'Group of stations out',P2:'Station out',P3:'Several sensors down',P4:'One sensor down',QC:'Quality check to review',PM:'Maintenance visit'};
