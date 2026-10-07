// Snapshot assessment of one station against its expected-sensor profile. This is instantaneous evidence;
// persistence and recovery hysteresis are applied by the incident engine over new ingests.
import {parseObservationKey,expectedAt,notExpectedReason,inferredGroup} from './profiles.mjs';
import {parseInstant} from './time.mjs';
export const HEALTH_VERSION='health-v1';
export const HEALTH_DEFAULTS={delayed:60,stale:180,channelLagMinutes:90,futureToleranceMinutes:5};
const qcList=qc=>Array.isArray(qc)?qc:Array.isArray(qc?.qc_flags)?qc.qc_flags:[];
const numeric=v=>typeof v==='number'&&Number.isFinite(v);
const minutes=ms=>Math.round(ms/60000);

export function assessStation({station,profile=[],units={},now=Date.now(),config={},maintenance=null,inResponse=true}){
 const c={...HEALTH_DEFAULTS,...config},obs=new Map(),derived=[];
 for(const [key,v] of Object.entries(station?.OBSERVATIONS||{})){
  const k=parseObservationKey(key);if(!k||!v||typeof v!=='object')continue;
  const entry={...k,value:v.value,time:parseInstant(v.date_time),qc:qcList(v.qc),qcStatus:v.qc?.status||null};
  if(k.derived)derived.push(entry);else obs.set(k.channel,entry);
 }
 const rows=new Map(profile.map(r=>[r.channel,r]));
 for(const [channel,o] of obs)if(!rows.has(channel)){const g=inferredGroup(o.variable,null);rows.set(channel,{channel,variable:o.variable,expected:'provisional',source:'coverage',sensorGroup:g.id,groupLabel:g.label,groupSource:'inferred',unit:units[o.variable]||null,note:'Observed without a profile entry.'});}
 const future=now+c.futureToleranceMinutes*60000;
 const channels=[...rows.values()].sort((a,b)=>a.channel.localeCompare(b.channel)).map(row=>{
  const o=obs.get(row.channel),expected=expectedAt(row,now),hasValue=o&&numeric(o.value);
  const ch={channel:row.channel,key:o?.key||null,variable:row.variable,unit:row.unit||units[row.variable]||null,position:row.position??null,sensorGroup:row.sensorGroup,groupLabel:row.groupLabel||row.sensorGroup,groupProvisional:row.groupSource!=='team',expected,expectation:row.expected,value:o?o.value??null:null,time:o?.time?new Date(o.time).toISOString():null,qc:o?.qc||[],qcStatus:o?.qcStatus||null,cadenceMinutes:row.cadenceMinutes||null,state:'ok',note:''};
  if(o?.time&&o.time>future){ch.state='future';ch.note='Observation time is ahead of the service clock.';}
  else if(!expected){ch.state='not-expected';ch.note=notExpectedReason(row,now);}
  else if(!o){ch.state='missing';ch.note='Expected channel absent from the latest response.';}
  else if(!hasValue){ch.state='null-value';ch.note='Returned without a numeric value (missing, not zero).';}
  else if(ch.qc.length||ch.qcStatus==='failed'){ch.state='qc-suspect';ch.note='Synoptic QC flag: evidence for review, not a confirmed fault.';}
  return ch;
 });
 const usable=channels.filter(ch=>ch.expected&&['ok','qc-suspect'].includes(ch.state)&&ch.time);
 const fallback=channels.filter(ch=>!ch.expected&&ch.state==='not-expected'&&numeric(ch.value)&&ch.time&&Date.parse(ch.time)<=future);
 const pool=usable.length?usable:fallback,newest=pool.length?Math.max(...pool.map(ch=>Date.parse(ch.time))):null;
 // Lag is measured against the station's newest channel so hourly and 5-minute channels are compared fairly.
 if(newest!==null)for(const ch of channels){
  if(!ch.expected||!['ok','qc-suspect'].includes(ch.state)||!ch.time)continue;
  const lag=minutes(newest-Date.parse(ch.time)),limit=Math.max(c.channelLagMinutes,(ch.cadenceMinutes||60)+30);
  ch.lagMinutes=lag;if(lag>limit){ch.state='stale';ch.note=`${lag} minutes behind the station's newest observation (limit ${limit}).`;}
 }
 const expectedChannels=channels.filter(ch=>ch.expected),ageMinutes=newest===null?null:Math.max(0,minutes(now-newest));
 const futureOnly=channels.some(ch=>ch.state==='future')&&!usable.length;
 let reporting;
 if(station?.STATUS==='INACTIVE')reporting='inactive';
 else if(maintenance)reporting='maintenance';
 else if(!inResponse)reporting='not-in-response';
 else if(futureOnly)reporting='clock';
 else if(newest===null)reporting='no-data';
 else if(ageMinutes>c.stale)reporting='outage-candidate';
 else if(ageMinutes>c.delayed)reporting='delayed';
 else reporting='reporting';
 // When the whole station is silent, its channels are not "reporting" even though they agree with each other.
 if(['outage-candidate','no-data'].includes(reporting))for(const ch of channels)if(ch.expected&&['ok','qc-suspect','stale'].includes(ch.state)){ch.state='silent';ch.note=`No new data for ${ch.time?Math.round((now-Date.parse(ch.time))/60000):'an unknown number of'} minutes (station not reporting).`;}
 // A missing expected channel may be a renamed/reprogrammed channel if a sibling at the same position started reporting.
 for(const ch of channels){
  if(!ch.expected||!['missing','null-value','stale'].includes(ch.state))continue;
  const sibling=channels.find(o=>o!==ch&&!o.expected&&o.variable===ch.variable&&String(o.position??'')===String(ch.position??'')&&o.state==='not-expected'&&o.expectation==='provisional'&&numeric(o.value));
  if(sibling){ch.state='possible-rename';ch.note=`Possible channel change to ${sibling.channel}; confirm in the sensor profile.`;}
 }
 const sensorPhase=['reporting','delayed'].includes(reporting);
 const issues=sensorPhase?channels.filter(ch=>ch.expected&&['missing','null-value','stale'].includes(ch.state)):[];
 const groups=[...new Map(issues.map(ch=>[ch.sensorGroup,{id:ch.sensorGroup,label:ch.groupLabel,provisional:ch.groupProvisional,channels:issues.filter(x=>x.sensorGroup===ch.sensorGroup).map(x=>x.channel)}])).values()];
 const qcSuspect=channels.filter(ch=>ch.state==='qc-suspect').map(ch=>ch.channel),reasons=[],codes=[];
 if(reporting==='outage-candidate'){codes.push('station-silent');reasons.push(`No expected channel has reported for ${ageMinutes} minutes (stale after ${c.stale}).`);}
 if(reporting==='no-data'){codes.push('no-data');reasons.push('No usable numeric observation in the latest response.');}
 if(reporting==='not-in-response'){codes.push('not-in-response');reasons.push('Station missing from the latest provider response; no new evidence this cycle.');}
 if(reporting==='delayed'){codes.push('delayed');reasons.push(`Newest expected observation is ${ageMinutes} minutes old (delayed after ${c.delayed}).`);}
 if(reporting==='clock'){codes.push('future-timestamp');reasons.push('Only future-dated observations were returned; check the logger clock.');}
 if(issues.length){codes.push(groups.length>1?'multiple-sensors':'single-sensor');reasons.push(`${issues.length} expected channel${issues.length===1?'':'s'} missing or stale across ${groups.length} ${groups.some(g=>g.provisional)?'provisional instrument group':'instrument'}${groups.length===1?'':'s'}: ${groups.map(g=>g.label).join('; ')}.`);}
 if(qcSuspect.length){codes.push('qc-suspect');reasons.push(`QC flags on ${qcSuspect.join(', ')} (review evidence).`);}
 const renamed=channels.filter(ch=>ch.state==='possible-rename');if(renamed.length){codes.push('possible-rename');reasons.push(renamed.map(ch=>ch.note).join(' '));}
 return {version:HEALTH_VERSION,stationId:station?.STID,name:station?.NAME||station?.STID,lat:Number.isFinite(+station?.LATITUDE)&&station?.LATITUDE!==null&&station?.LATITUDE!==''?+station.LATITUDE:null,lon:Number.isFinite(+station?.LONGITUDE)&&station?.LONGITUDE!==null&&station?.LONGITUDE!==''?+station.LONGITUDE:null,
  reporting,newest:newest===null?null:new Date(newest).toISOString(),ageMinutes,assessedAt:new Date(now).toISOString(),channels,expectedCount:expectedChannels.length,reportingCount:expectedChannels.filter(ch=>['ok','qc-suspect'].includes(ch.state)).length,
  issueKeys:issues.map(ch=>ch.channel),issueGroups:groups,provisionalGrouping:groups.some(g=>g.provisional),qcSuspect,reasonCodes:codes,reasons,thresholds:{delayed:c.delayed,stale:c.stale,channelLagMinutes:c.channelLagMinutes}};
}

// Classifies a provider snapshot before any station is judged, so a feed problem cannot become dozens of outages.
export function assessIngest({metadata,latest,previous=null,now=Date.now(),config={}}){
 const c={massOutageFraction:0.5,stale:180,...config},reasons=[],meta=metadata?.STATION||[],rows=latest?.STATION||[];
 const active=meta.filter(s=>s.STATUS!=='INACTIVE'),inResponse=new Set(rows.map(s=>s.STID));
 const fresh=rows.filter(s=>active.some(a=>a.STID===s.STID)).filter(s=>Object.entries(s.OBSERVATIONS||{}).some(([k,v])=>{const p=parseObservationKey(k);const t=parseInstant(v?.date_time);return p&&!p.derived&&numeric(v?.value)&&t&&now-t<=c.stale*60000&&t<=now+5*60000;}));
 const newestAll=Math.max(0,...rows.flatMap(s=>Object.values(s.OBSERVATIONS||{}).map(v=>parseInstant(v?.date_time)||0).filter(t=>t<=now+5*60000)));
 let quality='complete';
 if(!meta.length||!rows.length){quality='degraded';reasons.push('Provider returned no stations.');}
 const missing=active.filter(s=>!inResponse.has(s.STID));
 if(missing.length){quality='partial';reasons.push(`${missing.length} active station${missing.length===1?' was':'s were'} missing from the latest response.`);}
 if(previous?.activeCount&&active.length<previous.activeCount*0.8){quality='partial';reasons.push(`Metadata lists ${active.length} active stations, down from ${previous.activeCount}.`);}
 const fraction=active.length?fresh.length/active.length:0;
 if(active.length&&fraction<c.massOutageFraction){quality='degraded';reasons.push(`Only ${fresh.length} of ${active.length} active stations have recent observations; treating this as a possible provider problem.`);}
 if(newestAll&&now-newestAll>c.stale*60000){quality='degraded';reasons.push(`The newest observation in the whole response is ${minutes(now-newestAll)} minutes old.`);}
 return {quality,reasons,stationCount:meta.length,activeCount:active.length,responseCount:rows.length,freshCount:fresh.length,freshFraction:fraction,missingStations:missing.map(s=>s.STID),networkNewest:newestAll?new Date(newestAll).toISOString():null};
}
