import {neighbors,series,reference} from '../comparison.js';

export function attentionReasons(station, thresholds={delayed:60,stale:180}) {
  const reasons=[];
  if(station.status==='inactive')return ['Synoptic marks this station inactive; excluded from daily outage review.'];
  if(station.status==='unknown')reasons.push('No usable primary numeric observation in the latest response.');
  else if(station.status==='clock')reasons.push('Newest observation is more than five minutes ahead of the service clock.');
  else if(['stale','delayed'].includes(station.status))reasons.push(`Newest primary observation is ${station.ageMinutes} minutes old; ${station.status} threshold is ${thresholds[station.status]} minutes.`);
  if(station.flagged)reasons.push('Synoptic returned a QC flag or failed QC status; inspect the affected sensor and source flags.');
  return reasons.length?reasons:['No station-level freshness or QC flag in this snapshot; individual sensors may still need review.'];
}

function historyEvidence(station,cached,variable,hours) {
  if(!cached)return {stationId:station.id,stationName:station.name,distanceKm:station.distance??null,available:false,reason:'No history was loaded for this station and window before capture.',requestedHours:hours};
  const data=cached.body,s=series(data,variable),raw=data.STATION?.[0],times=(raw?.OBSERVATIONS?.date_time||[]).map(Date.parse).filter(Number.isFinite).sort((a,b)=>a-b);
  return {stationId:station.id,stationName:station.name,distanceKm:station.distance??null,available:true,source:'Synoptic stations/timeseries',fetchedAt:cached.at,requestedHours:hours,windowStart:times.length?new Date(times[0]).toISOString():null,windowEnd:times.length?new Date(times.at(-1)).toISOString():null,variable,sensor:s.key||null,unit:s.unit||null,points:s.points.map(p=>({time:new Date(p.t).toISOString(),value:p.v,qcFlagged:p.flagged})),sourceValues:raw?.OBSERVATIONS?.[s.key]||[],qc:raw?.QC?.[s.key]||[],sourceTimestamps:raw?.OBSERVATIONS?.date_time||[],qcSummary:data.QC_SUMMARY||null};
}

export function captureEvidence({network,stationId,hours=24,variable='air_temp',comparisonIds=[],getHistory,now=new Date().toISOString()}) {
  const station=network.stations.find(s=>s.id===stationId);
  if(!station)throw new Error('Select a station in the saved network inventory.');
  if(![24,72,168].includes(hours))throw new Error('Supported evidence windows are 24, 72 or 168 hours.');
  if(typeof variable!=='string'||!(/^[a-z][a-z0-9_]{0,79}$/).test(variable))throw new Error('Unsupported evidence variable.');
  if(!Array.isArray(comparisonIds)||comparisonIds.length>5)throw new Error('Select at most five loaded neighbors.');
  const permitted=neighbors(station,network.stations),ids=[...new Set(comparisonIds)];
  if(ids.some(id=>!permitted.some(s=>s.id===id)))throw new Error('Comparison stations must be among the nearest active neighbors.');
  const chosen=permitted.filter(s=>ids.includes(s.id));
  const histories=[station,...chosen].map(s=>historyEvidence(s,getHistory(s.id,hours),variable,hours));
  const comparable=histories.map(h=>({unit:h.unit,points:(h.points||[]).map(p=>({t:Date.parse(p.time),v:p.value,flagged:p.qcFlagged}))}));
  // Missing units cannot establish a valid same-unit reference.
  const ref=comparable[0].unit?reference(comparable[0],comparable.slice(1).filter(r=>r.unit)):null;
  return {schemaVersion:1,capturedAt:now,source:'Synoptic cached observations',networkFetchedAt:network.fetchedAt,cacheAgeMinutes:network.cacheAgeMinutes,thresholds:{delayed:network.connection.delayed,stale:network.connection.stale},reasons:attentionReasons(station,network.connection),station:structuredClone(station),qcSummary:network.qcSummary,window:{requestedHours:hours,variable},histories,comparison:{requested:ids.length>0,stationIds:chosen.map(s=>s.id),reference:ref?{...ref,time:new Date(ref.time).toISOString(),unit:comparable[0].unit}:null,method:'At least two same-unit, unflagged neighbors within ±5 minutes of the target latest unflagged reading; nearest active stations within 100 km.'},limitations:['Captured from the shared cache; capture does not refresh the network.','Observation time, API fetch time, and case capture time are distinct.','QC flags and differences are investigation clues, not confirmed equipment faults.','Current radar imagery is not stored or used as historical evidence.','Missing history, units, or neighbor reference is explicitly unavailable.']};
}

export function handoff(record,now=new Date().toISOString()) {
  const evidence=record.evidence||[],latest=evidence.at(-1);
  return {schemaVersion:1,kind:'enviroweather-field-handoff',exportedAt:now,case:{id:record.id,title:record.title,station:record.station,status:record.status,notes:record.notes,created:record.created,updated:record.updated,activity:record.activity||[]},evidence,visit:{stationId:latest?.station.id||record.station,stationName:latest?.station.name||record.station,reason:latest?.reasons.join(' ')||record.title,plannedChecks:record.plannedChecks||''},limitations:['Human review required before a field visit. No logger writes, ticket creation, or team messages are performed.',...latest?.limitations||[]]};
}

export function handoffText(record,now=new Date().toISOString()) {
  const h=handoff(record,now),e=h.evidence.at(-1);
  const lines=['ENVIROWEATHER FIELD-VISIT HANDOFF','For human review — not a hardware diagnosis','',`Exported (UTC): ${h.exportedAt}`,`Case: ${h.case.title}`,`Case ID: ${h.case.id}`,`Status: ${h.case.status}`,`Station: ${h.visit.stationName} (${h.visit.stationId})`,`Reason: ${h.visit.reason}`,'','PLANNED CHECKS',h.visit.plannedChecks||'Not recorded.','', 'INVESTIGATION NOTES',h.case.notes||'Not recorded.'];
  if(e){lines.push('','SAVED EVIDENCE',`Captured (UTC): ${e.capturedAt}`,`Network fetched (UTC): ${e.networkFetchedAt||'Unavailable'}`,`Network cache age at capture: ${e.cacheAgeMinutes??'Unavailable'} minutes`,`Thresholds: delayed ${e.thresholds.delayed} min / stale ${e.thresholds.stale} min`,`Requested history: ${e.window.requestedHours} hours / ${e.window.variable}`,'','LATEST SENSOR READINGS');for(const f of e.station.fields)lines.push(`${f.key}: ${f.value??'Missing'} ${f.unit||'(units unavailable)'} | observed ${f.time||'unknown'} | QC ${f.qc?.length?f.qc.join(', '):f.qcStatus||'no flag returned'}`);lines.push('','HISTORY / COMPARISON SOURCES');for(const s of e.histories)lines.push(s.available?`${s.stationName} (${s.stationId}): ${s.points.length} numeric readings; ${s.points.filter(p=>p.qcFlagged).length} flagged; ${s.unit||'units unavailable'}; ${s.windowStart||'unknown'} to ${s.windowEnd||'unknown'}; fetched ${s.fetchedAt}`:`${s.stationName} (${s.stationId}): ${s.reason}`);const ref=e.comparison.reference;lines.push(ref?`Reference at ${ref.time}: target ${ref.value} ${ref.unit}, neighbor median ${ref.median}, difference ${ref.delta}, ${ref.count} neighbors.`:'Neighbor reference: unavailable.','Full readings and source QC are retained in the companion handoff JSON.');}
  lines.push('','CASE ACTIVITY');for(const a of h.case.activity)lines.push(`${a.at} | ${a.action}${a.status?' | '+a.status:''}`);
  lines.push('','LIMITATIONS',...h.limitations.map(s=>'- '+s));return lines.join('\n')+'\n';
}
