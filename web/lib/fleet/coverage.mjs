// Per-station, per-variable nearby-reference coverage from the latest snapshot. Extends web/lib/reference.mjs:
// the 500 m independence rule, unit matching, QC exclusion, ±5-minute alignment and median/MAD band are kept.
// Robust statistics are investigation evidence, not certified ground truth.
import {distance} from '../../comparison.js';
import {band,median,settings as referenceSettings} from '../reference.mjs';
import {isDaylight} from './time.mjs';
export const COVERAGE_VERSION='coverage-v1';
export const COVERAGE_VARIABLES={
 air_temp:{label:'Air temperature',kind:'linear',tolerance:3,units:['Celsius','C','degC'],heightToleranceM:1},
 relative_humidity:{label:'Relative humidity',kind:'linear',tolerance:20,units:['%','percent'],heightToleranceM:1},
 wind_speed:{label:'Wind speed',kind:'linear',tolerance:3,units:['m/s','Meters per second'],heightToleranceM:0.5},
 wind_direction:{label:'Wind direction',kind:'circular',tolerance:45,units:['Degrees','degrees','°'],heightToleranceM:0.5,calmMs:1},
 solar_radiation:{label:'Solar radiation',kind:'linear',tolerance:200,units:['W/m**2','W/m2','W/m²','Watts per square meter'],daylightOnly:true},
 precip_accum_one_hour:{label:'Rainfall · preceding hour',kind:'linear',tolerance:5,units:['Millimeters','mm'],localVariability:true},
 soil_temp:{label:'Soil temperature',kind:'linear',tolerance:3,units:['Celsius','C','degC'],depthExact:true}
};
const num=v=>typeof v==='number'&&Number.isFinite(v);
export const angularDifference=(a,b)=>{const d=((a-b)%360+540)%360-180;return d;};
export function circularMean(values){const s=values.reduce((t,v)=>t+Math.sin(v*Math.PI/180),0),c=values.reduce((t,v)=>t+Math.cos(v*Math.PI/180),0);if(Math.hypot(s,c)<1e-9)return null;return (Math.atan2(s,c)*180/Math.PI+360)%360;}
// Channel position metadata (metres; negative = depth). Unknown stays null.
function positionOf(station,channel){const variable=channel.replace(/_\d+$/,'');const p=station.sensors?.[variable]?.[channel]?.position;return p===undefined||p===null||p===''?null:Number(p);}
function channelsFor(station,variable){
 return (station.fields||[]).filter(f=>f.variable===variable&&!f.derived).map(f=>{const channel=f.key.replace(/_value_(\d+)$/,'_$1');return {channel,key:f.key,value:f.value,t:Date.parse(f.time),unit:f.unit,flagged:!!f.qc?.length||f.qcStatus==='failed',position:positionOf(station,channel)};}).sort((a,b)=>a.channel.localeCompare(b.channel));
}
function matchChannel(spec,target,candidates){
 if(spec.depthExact){if(target.position===null)return {reason:'Target depth unknown; soil sensors at unknown depths are not compared.'};const c=candidates.find(c=>c.position!==null&&Math.abs(c.position-target.position)<0.005);return c?{channel:c}:{reason:candidates.some(c=>c.position===null)?'Reference depth unknown.':`No sensor at ${target.position} m depth.`};}
 if(spec.heightToleranceM!==undefined&&target.position!==null){const c=candidates.find(c=>c.position!==null&&Math.abs(c.position-target.position)<=spec.heightToleranceM);if(c)return {channel:c};const c2=candidates.find(c=>c.position===null);if(c2)return {channel:c2,warning:'Reference sensor height unknown.'};return {reason:`Sensor height differs (${candidates.map(c=>c.position+' m').join(', ')} vs ${target.position} m).`};}
 return candidates[0]?{channel:candidates[0],...(target.position===null||candidates[0].position===null?{warning:'Sensor height unknown.'}:{})}:{reason:'No matching sensor.'};
}
// overrides: [{variable, reference, action:'pin'|'exclude', reason, removed_at}]
export function stationCoverage(target,stations,{options={},overrides=[],now=Date.now()}={}){
 const o=referenceSettings({radiusKm:options.radiusKm??100,minNeighbors:options.minNeighbors??3,toleranceScale:options.toleranceScale??1,maxAgeMinutes:options.maxAgeMinutes??90});
 const active=stations.filter(s=>s.id!==target.id&&s.archiveStatus!=='INACTIVE'&&Number.isFinite(s.lat)&&Number.isFinite(s.lon)),rows=[];
 for(const [variable,spec] of Object.entries(COVERAGE_VARIABLES)){
  let targets=channelsFor(target,variable);
  // An installed sensor that is silent still has a position in metadata; it is "not reporting", not "absent".
  if(!targets.length)targets=Object.keys(target.sensors?.[variable]||{}).sort().map(channel=>({channel,key:null,value:null,t:NaN,unit:target.units?.[variable]||spec.units[0],flagged:false,position:positionOf(target,channel),silent:true}));
  const slots=spec.depthExact?targets:targets.slice(0,1);
  if(!slots.length){rows.push({variable,label:spec.label,position:null,status:'no-target-sensor',reason:'Station has no sensor for this variable.',references:[],excluded:[]});continue;}
  for(const t of slots){
   const live=overrides.filter(x=>!x.removed_at&&x.variable===variable),pins=new Set(live.filter(x=>x.action==='pin').map(x=>x.reference)),blocks=new Set(live.filter(x=>x.action==='exclude').map(x=>x.reference));
   const row={variable,label:spec.label,channel:t.channel,position:t.position,unit:t.unit,target:{value:num(t.value)?t.value:null,time:Number.isFinite(t.t)?new Date(t.t).toISOString():null,flagged:t.flagged},references:[],excluded:[],warnings:[],status:'insufficient',reason:''};
   if(t.silent)row.targetMissing=true;
   if(!t.silent&&!spec.units.includes(t.unit)){row.status='unavailable';row.reason='Target unit unavailable or unsupported.';rows.push(row);continue;}
   const refTime=Number.isFinite(t.t)&&now-t.t<=o.maxAgeMinutes*60000?t.t:now;
   if(spec.daylightOnly&&isDaylight(refTime,target.lat,target.lon)===false){row.status='not-applicable';row.reason='Solar comparison is not meaningful at night; zero readings are valid.';rows.push(row);continue;}
   const chosen=[];
   const candidates=active.map(s=>({s,d:distance(target,s)})).filter(x=>x.d<=o.radiusKm||pins.has(x.s.id)).sort((a,b)=>(pins.has(b.s.id)-pins.has(a.s.id))||a.d-b.d);
   for(const {s,d} of candidates){
    const ex=reason=>row.excluded.push({id:s.id,name:s.name,distanceKm:Math.round(d*10)/10,reason});
    if(blocks.has(s.id)){ex('Excluded by a team override.');continue;}
    if(d<0.5){ex('Co-located with the target (under 500 m); not independent.');continue;}
    if(chosen.some(c=>distance(c.s,s)<0.5)){ex('Co-located with another chosen reference.');continue;}
    const m=matchChannel(spec,t,channelsFor(s,variable));
    if(!m.channel){ex(m.reason);continue;}
    const c=m.channel;
    if(!t.silent&&c.unit!==t.unit||t.silent&&!spec.units.includes(c.unit)){ex(`Unit mismatch (${c.unit||'none'}).`);continue;}
    if(!num(c.value)||!Number.isFinite(c.t)){ex('No usable latest reading.');continue;}
    if(c.flagged){ex('QC flag on the reference reading.');continue;}
    if(now-c.t>o.maxAgeMinutes*60000||c.t-now>300000){ex('Reference reading is stale or future-dated.');continue;}
    if(!t.silent&&Math.abs(c.t-refTime)>o.alignmentMinutes*60000){ex(`Not aligned within ±${o.alignmentMinutes} minutes of the target time.`);continue;}
    if(t.silent&&chosen.length&&Math.abs(c.t-chosen[0].c.t)>o.alignmentMinutes*60000){ex(`Not aligned within ±${o.alignmentMinutes} minutes of the other references.`);continue;}
    if(spec.kind==='circular'){const sp=channelsFor(s,'wind_speed')[0];if(!sp||!num(sp.value)||sp.value<spec.calmMs){ex('Calm or unknown wind speed; direction undefined.');continue;}}
    const warnings=[];if(m.warning)warnings.push(m.warning);
    const de=Number.isFinite(target.elevationFt)&&Number.isFinite(s.elevationFt)?Math.round((s.elevationFt-target.elevationFt)*0.3048):null;
    if(de!==null&&Math.abs(de)>150)warnings.push(`Elevation differs by ${de} m.`);
    if(pins.has(s.id)){warnings.push('Pinned by a team override.');if(d>o.radiusKm)warnings.push(`Pinned reference is ${Math.round(d)} km away, outside the ${o.radiusKm} km radius.`);}
    chosen.push({s,d,c,warnings});if(chosen.length===5)break;
   }
   row.references=chosen.map(({s,d,c,warnings})=>({id:s.id,name:s.name,distanceKm:Math.round(d*10)/10,value:c.value,time:new Date(c.t).toISOString(),channel:c.channel,position:c.position,warnings,pinned:pins.has(s.id)}));
   for(const r of row.references)row.warnings.push(...r.warnings.map(w=>`${r.name}: ${w}`));
   if(row.references.length<o.minNeighbors){row.residual=null;row.inBand=null;row.reason=`Need ${o.minNeighbors} independent, matching, fresh, unflagged references within ${o.radiusKm} km; found ${row.references.length}.`;rows.push(row);continue;}
   row.status='available';row.reason=`${row.references.length} references.${row.targetMissing?' Target sensor not reporting in this snapshot.':''}`;
   const values=row.references.map(r=>r.value);
   if(spec.kind==='circular'){const centre=circularMean(values);row.band=centre===null?null:{median:centre,tolerance:spec.tolerance*o.toleranceScale,circular:true};}
   else row.band=band(values,spec.tolerance*o.toleranceScale);
   const targetUsable=row.target.value!==null&&!t.flagged&&Number.isFinite(t.t)&&now-t.t<=o.maxAgeMinutes*60000&&t.t-now<=300000;
   if(targetUsable&&row.band){
    if(spec.kind==='circular'){const sp=channelsFor(target,'wind_speed')[0];if(!sp||!num(sp.value)||sp.value<spec.calmMs){row.residual=null;row.inBand=null;row.warnings.push('Target wind calm; direction comparison skipped.');}else{row.residual=angularDifference(row.target.value,row.band.median);row.inBand=Math.abs(row.residual)<=row.band.tolerance;}}
    else{row.residual=row.target.value-row.band.median;row.inBand=row.target.value>=row.band.low&&row.target.value<=row.band.high;}
   }else{row.residual=null;row.inBand=null;row.warnings.push('Target reading unavailable, flagged or stale; references are listed but no residual is computed. Neighbour values never replace target observations.');}
   if(spec.localVariability)row.warnings.push('Convective rainfall can differ sharply over short distances.');
   rows.push(row);
  }
 }
 const core=rows.filter(r=>['air_temp','relative_humidity','wind_speed','solar_radiation','precip_accum_one_hour'].includes(r.variable));
 return {version:COVERAGE_VERSION,station:target.id,generatedAt:new Date(now).toISOString(),settings:o,rows,referenceGap:core.filter(r=>!['available','not-applicable','no-target-sensor'].includes(r.status)).length,method:'Up to five nearest independent stations (≥500 m apart) per variable with matching units, height or depth, fresh unflagged readings aligned within ±5 minutes; band = max(provisional tolerance, 3 × 1.4826 × MAD) around the median (circular mean for wind direction).'};
}
// Variable-aware flatline screening over a history series; produces suspicion, never certainty.
export function flatline(points,variable,{lat=null,lon=null}={}){
 const usable=(points||[]).filter(p=>num(p.v)&&Number.isFinite(p.t)&&!p.flagged).sort((a,b)=>a.t-b.t);
 if(usable.length<4)return null;
 const rules={air_temp:{hours:6},relative_humidity:{hours:12,ignoreAbove:97},wind_speed:{hours:6,zeroHours:24},wind_direction:{hours:12},solar_radiation:{hours:3,daylightOnly:true},soil_temp:{hours:48},soil_moisture:{hours:168}}[variable];
 if(!rules)return null;// precipitation zeros are always valid
 let best=null,start=0;
 for(let i=1;i<=usable.length;i++){
  if(i<usable.length&&usable[i].v===usable[start].v)continue;
  const run=usable.slice(start,i),v=run[0].v,hours=(run.at(-1).t-run[0].t)/36e5;start=i;
  if(rules.ignoreAbove&&v>=rules.ignoreAbove)continue;
  let limit=rules.hours;if(variable==='wind_speed'&&v===0)limit=rules.zeroHours;
  if(rules.daylightOnly){const day=run.filter(p=>isDaylight(p.t,lat,lon)!==false);if(v===0&&day.length<run.length)continue;if((day.at(-1)?.t-day[0]?.t)/36e5<limit)continue;}
  if(hours>=limit&&(!best||hours>best.hours))best={value:v,start:new Date(run[0].t).toISOString(),end:new Date(run.at(-1).t).toISOString(),hours:Math.round(hours*10)/10,readings:run.length};
 }
 return best?{...best,variable,message:`Constant value ${best.value} for ${best.hours} h (${best.readings} readings). Possible stuck sensor; confirm against references and site conditions.`}:null;
}
export {median};
