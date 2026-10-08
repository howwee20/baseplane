// Fleet operations: ingest assessment, incidents, alerts, work items, station notes, references and field-day plans.
// All routes here sit behind authenticate(); the caller has already rejected viewer writes.
import {AppError,readDoc,saveDoc} from './storage.mjs';
import * as store from './fleet-store.mjs';
import {processSnapshot,processFailure,assessNetwork,maintenanceActive} from '../web/lib/fleet/pipeline.mjs';
import {assessStation} from '../web/lib/fleet/health.mjs';
import {FLEET_DEFAULTS,ENGINE_VERSION,WORKFLOW_STATES} from '../web/lib/fleet/engine.mjs';
import {PRIORITY_VERSION,DEFAULT_DEADLINES,TIERS,TIE_BREAKERS,effectiveTier,priorityKey,priorityReasons,tierRank} from '../web/lib/fleet/priority.mjs';
import {HEALTH_VERSION} from '../web/lib/fleet/health.mjs';
import {validateGrouping,GROUPING_RATIONALE} from '../web/lib/fleet/grouping.mjs';
import {buildQueue} from '../web/lib/fleet/queue.mjs';
import {validateProfileEdit} from '../web/lib/fleet/profiles.mjs';
import {stationCoverage,COVERAGE_VARIABLES} from '../web/lib/fleet/coverage.mjs';
import {newWorkItem,applyWorkPatch,workHandoff,suggestTemplates,TEMPLATES,validateWindows} from '../web/lib/fleet/work.mjs';
import {validateRules,TASK_CLASSES} from '../web/lib/fleet/forecast.mjs';
import {validatePlanInputs,planDay,planOutdated,PLANNER_DEFAULTS,PLANNER_VERSION,planDates,unroutedDay} from '../web/lib/fleet/planner.mjs';
import {navigationLinks} from '../web/lib/fleet/routing.mjs';
import {distance} from '../web/comparison.js';
import {localToUtc,addDays} from '../web/lib/fleet/time.mjs';
import {forecastsFor} from './providers/nws.mjs';
import {routeMatrix,routeGeometry,routingStatus,MAX_MATRIX_POINTS} from './providers/routing.mjs';
import {pruneCache,cacheRead} from './providers/cache.mjs';

const json=(b,status=200)=>new Response(JSON.stringify(b),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const str=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';

// ---------- configuration ----------
export async function fleetSettings(env){
 const saved=(await readDoc(env.DB,'fleet-settings'))?.body||{};
 return {fleet:{...FLEET_DEFAULTS,...saved.fleet,grouping:{...FLEET_DEFAULTS.grouping,...saved.fleet?.grouping}},deadlines:{...DEFAULT_DEADLINES,...saved.deadlines},rules:validateRules(saved.rules||{}),planner:{...PLANNER_DEFAULTS,...saved.planner},updatedBy:saved.updatedBy||null,updated:saved.updated||null};
}
function validateFleetSettings(b,current){
 const f={...current.fleet,...(b.fleet||{})};
 for(const [k,lo,hi] of [['outageConfirmCount',1,8],['recoveryConfirmCount',1,8],['sensorConfirmCount',1,12],['reopenWindowHours',1,168],['channelLagMinutes',30,1440],['retiredAfterDays',7,365],['provisionalAfterHours',1,336],['alertCapPerIngest',3,50]])if(!(Number.isInteger(f[k])&&f[k]>=lo&&f[k]<=hi))throw new AppError(`${k} must be a whole number from ${lo} to ${hi}.`);
 if(!(f.massOutageFraction>=0.1&&f.massOutageFraction<=0.9))throw new AppError('massOutageFraction must be 0.1–0.9.');
 try{f.grouping=validateGrouping(f.grouping);}catch(e){throw new AppError(e.message);}
 const deadlines={...current.deadlines,...(b.deadlines||{})};for(const [k,v] of Object.entries(deadlines))if(!TIERS[k]||!(Number.isInteger(v)&&v>=1&&v<=2160))throw new AppError('Deadlines are whole hours from 1 to 2160 per tier.');
 let rules;try{rules=validateRules(b.rules||current.rules);}catch(e){throw new AppError(e.message);}
 const planner={...current.planner,...(b.planner||{})};
 if(planner.bases!==undefined){if(!Array.isArray(planner.bases)||planner.bases.length>10)throw new AppError('Use up to 10 base locations.');planner.bases=planner.bases.map(x=>{const lat=Number(x?.lat),lon=Number(x?.lon),label=str(x?.label,100);if(!label||!(lat>=40&&lat<=49.5&&lon>=-92&&lon<=-80))throw new AppError('Base locations need a label and Michigan coordinates.');return {label,lat,lon};});}
 try{validatePlanInputs({...planner,date:'2026-01-05',start:planner.start||{lat:42.7,lon:-84.5}});}catch(e){throw new AppError('Planner defaults: '+e.message);}
 return {fleet:f,deadlines,rules,planner};
}

// ---------- ingest assessment ----------
async function lease(env,name,ms){const owner=crypto.randomUUID(),now=Date.now();const got=await env.DB.prepare('INSERT INTO locks(name,owner,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE expires<? RETURNING owner').bind(name,owner,now+ms,now).first();return got?.owner===owner?owner:null;}
const release=(env,name,owner)=>env.DB.prepare('DELETE FROM locks WHERE name=? AND owner=?').bind(name,owner).run();
export async function runAssessment(env,{metadata,latest,ingestId,retrievedAt,thresholds}){
 const owner=await lease(env,'assessment',120000);if(!owner)return {skipped:'Another assessment is running.'};
 try{
  if(await env.DB.prepare('SELECT 1 FROM ingests WHERE id=? AND assessed_at IS NOT NULL').bind(ingestId).first())return {skipped:'Already assessed.'};
  const {fleet}=await fleetSettings(env);
  for(let attempt=0;attempt<3;attempt++){
   const [profiles,states,incidents,notes,previous]=await Promise.all([store.loadProfiles(env.DB),store.loadStationStates(env.DB),store.loadEngineIncidents(env.DB,fleet.reopenWindowHours),store.allStationNotes(env.DB),store.latestIngest(env.DB)]);
   const r=processSnapshot({metadata,latest,ingestId,retrievedAt,previousIngest:previous,profiles:profiles.stations,notes,stationStates:states.states,incidents,thresholds,config:fleet});
   for(const row of r.profileChanges)row.revision=crypto.randomUUID();
   const changedStates=Object.fromEntries(Object.entries(r.stationStates).map(([k,{repeat,...v}])=>[k,v]));
   try{
    const statements=await store.saveEngineResult(env.DB,{ingest:r.ingest,result:r,loadedRevisions:new Map(incidents.map(i=>[i.id,i.revision])),profiles:r.profileChanges.length?{stations:{...profiles.stations,...r.profileRows},revision:profiles.revision}:null,stationStates:Object.keys(changedStates).length?{states:{...states.states,...changedStates},revision:states.revision}:null,engine:`${ENGINE_VERSION}+${PRIORITY_VERSION}+${HEALTH_VERSION}`});
    await saveDoc(env.DB,'cache:health','cache',{data:compactHealth(r.assessments),sourceAt:retrievedAt,ingestId,quality:r.ingest.quality});
    return {ingest:r.ingest,incidents:r.incidents.length,alerts:r.alerts.length,statements};
   }catch(e){if(e.status===409&&attempt<2)continue;throw e;}
  }
 }finally{await release(env,'assessment',owner);}
}
export async function runFeedFailure(env,reason){
 const owner=await lease(env,'assessment',60000);if(!owner)return;
 try{const {fleet}=await fleetSettings(env),incidents=await store.loadEngineIncidents(env.DB,fleet.reopenWindowHours),r=processFailure({ingestId:crypto.randomUUID(),retrievedAt:new Date().toISOString(),reason,incidents,config:fleet});
  await store.saveEngineResult(env.DB,{ingest:r.ingest,result:r,loadedRevisions:new Map(incidents.map(i=>[i.id,i.revision])),engine:ENGINE_VERSION});}
 finally{await release(env,'assessment',owner);}
}
// One statement either way, so recording assessment health never eats into the D1 query budget.
export async function recordAssessmentError(env,message){if(message)await env.DB.prepare("INSERT INTO fleet_blobs(key,body,revision,updated,updated_by) VALUES('assessment-error',?,?,?,'system') ON CONFLICT(key) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated=excluded.updated").bind(JSON.stringify({message,at:new Date().toISOString()}),crypto.randomUUID(),new Date().toISOString()).run();else await env.DB.prepare("DELETE FROM fleet_blobs WHERE key='assessment-error'").run();}
export async function assessmentError(env){const b=(await store.readBlob(env.DB,'assessment-error')).body;return b?.message?b:null;}
function compactHealth(assessments){const out={};for(const a of assessments)out[a.stationId]={name:a.name,reporting:a.reporting,newest:a.newest,ageMinutes:a.ageMinutes,expectedCount:a.expectedCount,reportingCount:a.reportingCount,issueKeys:a.issueKeys,issueGroups:a.issueGroups.map(g=>({id:g.id,label:g.label,provisional:g.provisional,channels:g.channels})),qcSuspect:a.qcSuspect,reasonCodes:a.reasonCodes,reasons:a.reasons,assessedAt:a.assessedAt};return out;}
export async function scheduledMaintenance(env){await store.pruneFleet(env.DB);await pruneCache(env.DB);}

// ---------- overview ----------
async function healthSnapshot(env){const doc=await readDoc(env.DB,'cache:health');return doc?{health:doc.body.data,at:doc.body.sourceAt,ingestId:doc.body.ingestId,quality:doc.body.quality}:{health:{},at:null,ingestId:null,quality:null};}
export async function opsView(env,network){
 const [{fleet,deadlines},health,incidents,work,plans,notes,openAlerts,ingests,recent]=await Promise.all([fleetSettings(env),healthSnapshot(env),store.openIncidents(env.DB),store.listWork(env.DB,{open:true,limit:500}),store.listPlans(env.DB,{status:'accepted',limit:50}),store.allStationNotes(env.DB),store.countOpenAlerts(env.DB),store.recentIngests(env.DB,1),store.listAlerts(env.DB,{open:false,limit:8})]);
 const q=buildQueue({incidents,health:health.health,work,plans:plans.map(p=>({...p,stations:p.summary?.stations||[]})),notes,now:Date.now(),deadlines});
 const last=ingests[0]||null,cacheAge=network.cacheAgeMinutes;
 const feedStatus=!network.fetchedAt?'unknown':last?.status==='failed'||network.lastError?'failed':last&&last.quality!=='complete'?'degraded':cacheAge>45?'stale':'ok';
 const regions=[...new Set(Object.values(notes).map(n=>n.region).filter(Boolean))].sort();
 return {versions:{engine:ENGINE_VERSION,priority:PRIORITY_VERSION,health:HEALTH_VERSION},
  feed:{status:feedStatus,lastIngest:last,cacheAgeMinutes:cacheAge,networkFetchedAt:network.fetchedAt,healthAt:health.at,incident:q.feed[0]||null,reasons:q.feed[0]?.reasons||last?.reasons||[]},
  counts:q.counts,countNote:q.countNote,queue:q.queue,health:health.health,openAlerts,recentAlerts:recent.alerts.filter(a=>Date.now()-Date.parse(a.created)<864e5),regions,
  detection:{pollMinutes:15,delayed:network.connection?.delayed??60,stale:network.connection?.stale??180,outageConfirmCount:fleet.outageConfirmCount,recoveryConfirmCount:fleet.recoveryConfirmCount,note:`A station is suspected out once no expected channel has reported for ${network.connection?.stale??180} minutes, and confirmed after ${fleet.outageConfirmCount} consecutive new snapshots without data (polled every 15 minutes). Expect detection about ${network.connection?.stale??180}–${(network.connection?.stale??180)+15*fleet.outageConfirmCount+15} minutes after the last report. This is not instantaneous monitoring.`},
  grouping:{...fleet.grouping,rationale:GROUPING_RATIONALE},tiers:TIERS,tieBreakers:TIE_BREAKERS};
}

// ---------- station detail ----------
async function stationDetail(env,user,stationId,ctx){
 const network=await ctx.networkView(env),s=network.stations.find(x=>x.id===stationId);if(!s)throw new AppError('Unknown station.',404);
 const [profile,incidents,work,notes,overrides,meta,latest,{fleet}]=await Promise.all([store.stationProfile(env.DB,stationId),store.listIncidents(env.DB,{state:'all',station:stationId,limit:20}),store.listWork(env.DB,{station:stationId,limit:50}),store.getStationNotes(env.DB,stationId),store.referenceOverrides(env.DB,stationId),ctx.cacheGet(env,'metadata'),ctx.cacheGet(env,'latest'),fleetSettings(env)]);
 const rawMeta=meta?.body.STATION?.find(x=>x.STID===stationId),rawLatest=latest?.body.STATION?.find(x=>x.STID===stationId);
 const now=Date.now(),health=assessStation({station:{...rawMeta,...rawLatest,SENSOR_VARIABLES:rawMeta?.SENSOR_VARIABLES||rawLatest?.SENSOR_VARIABLES},profile,units:latest?.body.UNITS||{},now,config:{delayed:network.connection.delayed,stale:network.connection.stale,channelLagMinutes:fleet.channelLagMinutes},maintenance:maintenanceActive(notes,now),inResponse:!!rawLatest});
 const coverage=stationCoverage(s,network.stations,{overrides,now});
 const groupIds=[...new Set(incidents.incidents.map(i=>i.groupId).filter(Boolean))],groups=(await Promise.all(groupIds.map(g=>store.getIncident(env.DB,g)))).filter(Boolean);
 const state=(await store.loadStationStates(env.DB)).states[stationId]||null;
 return {station:{id:s.id,name:s.name,lat:s.lat,lon:s.lon,elevationFt:s.elevationFt,archiveStatus:s.archiveStatus,status:s.status,last:s.last,ageMinutes:s.ageMinutes},fetchedAt:network.fetchedAt,health,profile,incidents:incidents.incidents,groups,work,notes:redactNotes(notes,user),coverage,overrides,engineState:state,templates:Object.fromEntries(Object.entries(TEMPLATES).map(([k,v])=>[k,{label:v.label,taskClass:v.taskClass,estimateMinutes:v.estimateMinutes,uncertaintyMinutes:v.uncertaintyMinutes,onSite:v.onSite}]))};
}
function redactNotes(n,user){if(!n)return n;if(user.role==='viewer'&&n.gateCode)return {...n,gateCode:null,gateCodeRestricted:true};return n;}
function validateNotes(b){
 const out={accessNotes:str(b.accessNotes,4000),gateCode:str(b.gateCode,100)||null,contacts:str(b.contacts,2000),region:str(b.region,60)||null,importance:Number.isInteger(b.importance)&&b.importance>=0&&b.importance<=3?b.importance:0,parking:str(b.parking,1000),hazards:str(b.hazards,2000)};
 if(b.entrance!==undefined&&b.entrance!==null){const lat=Number(b.entrance.lat),lon=Number(b.entrance.lon);if(!(lat>=40&&lat<=49.5&&lon>=-92&&lon<=-80))throw new AppError('Road entrance must be valid Michigan coordinates.');out.entrance={lat,lon,label:str(b.entrance.label,100)};}else out.entrance=null;
 try{out.accessWindows=validateWindows(b.accessWindows);}catch(e){throw new AppError(e.message);}
 if(b.maintenance){const from=Date.parse(b.maintenance.from),until=Date.parse(b.maintenance.until),reason=str(b.maintenance.reason,300);if(!Number.isFinite(from)||!Number.isFinite(until)||until<=from||reason.length<3)throw new AppError('Planned maintenance needs from/until times and a reason.');out.maintenance={from:new Date(from).toISOString(),until:new Date(until).toISOString(),reason};}else out.maintenance=null;
 out.dependencies=Array.isArray(b.dependencies)?b.dependencies.filter(x=>typeof x==='string').map(x=>x.trim().slice(0,60)).filter(Boolean).slice(0,10):[];
 return out;
}

// ---------- planning context ----------
const CLASS_ORDER=['inspection','electronics','exposed'];
async function planningContext(env,inputs,{excludePlanId=null,networkView}){
 const [incidents,work,notes,accepted,{rules,deadlines},health]=await Promise.all([store.openIncidents(env.DB),store.listWork(env.DB,{open:true,limit:500}),store.allStationNotes(env.DB),store.listPlans(env.DB,{status:'accepted',from:inputs.date,to:addDays(inputs.date,inputs.days-1),limit:100}),fleetSettings(env),healthSnapshot(env)]);
 // Team-adopted task-weather rules come from owner settings, never from the request.
 inputs={...inputs,rules};
 const network=await networkView(env),byId=new Map(network.stations.map(s=>[s.id,s]));
 const q=buildQueue({incidents,health:health.health,work,notes,now:Date.now(),deadlines});
 const entries=new Map();
 const add=(sid,item,group=null)=>{if(!byId.has(sid)||inputs.excludeStations.includes(sid))return;if(inputs.region&&notes[sid]?.region!==inputs.region)return;const e=entries.get(sid);if(!e||compareTier(item,e.item)<0)entries.set(sid,{item,group});};
 const compareTier=(a,b)=>tierRank(a.effectiveTier)-tierRank(b.effectiveTier);
 for(const it of q.queue){if(!inputs.tiers.includes(it.effectiveTier))continue;if(it.scope==='group')for(const m of it.members?.length?it.members:it.stations.map(s=>({...it,station:s})))add(m.station,{...m,effectiveTier:it.effectiveTier,tier:it.tier,priorityKey:it.priorityKey,priorityReasons:it.priorityReasons},it);else if(it.station)add(it.station,it);}
 // Stations the user added keep the priority of any open issue; otherwise they are plain visits.
 const allItems=q.queue.flatMap(it=>it.scope==='group'?(it.members?.length?it.members:it.stations.map(s=>({...it,station:s}))).map(m=>({...m,effectiveTier:it.effectiveTier,tier:it.tier,priorityKey:it.priorityKey,priorityReasons:it.priorityReasons,_group:it})):[it]);
 for(const sid of inputs.required)if(!entries.has(sid)&&byId.has(sid)){const it=allItems.find(x=>x.station===sid);entries.set(sid,it?{item:it,group:it._group||null}:{item:{id:'visit:'+sid,effectiveTier:'PM',tier:'PM',priorityKey:priorityKey({id:'visit:'+sid,tier:'PM'}),priorityReasons:['Added to the trip; no open issue'],station:sid},group:null});}
 const planned=new Map();for(const p of accepted)if(p.id!==excludePlanId)for(const s of p.summary?.stations||[])if(!planned.has(s))planned.set(s,{planId:p.id,title:p.title,crew:p.crew,date:p.date});
 const pre=[],candidates=[];
 const maxKm=Math.min(420,inputs.maxWorkdayMinutes/2*80/60*1.05);
 for(const [sid,{item,group}] of entries){
  const st=byId.get(sid),n=notes[sid]||{},items=work.filter(w=>w.station===sid&&w.onSite!==false);
  const lat=n.entrance?.lat??st.lat,lon=n.entrance?.lon??st.lon;
  const tpl=items.length?null:TEMPLATES[item.kind==='outage'||item.scope==='group'?'comms-power':item.scope==='review'?'sensor-inspection':item.scope==='maintenance'?'scheduled-service':'sensor-inspection'];
  const est=items.length?items.every(w=>Number.isInteger(w.estimateMinutes))?items.reduce((s,w)=>s+w.estimateMinutes,0):null:tpl.estimateMinutes;
  const c={id:sid,stationId:sid,name:st.name,lat,lon,entranceKnown:!!n.entrance,tier:item.effectiveTier,priorityKey:item.priorityKey,priorityReasons:item.priorityReasons||[],incidentIds:[item.id,group?.id].filter(x=>x&&!/^(qc|pm|required|visit):/.test(x)),groupId:group?.id||null,workItemIds:items.map(w=>w.id),
   tasks:items.length?items.flatMap(w=>(w.confirmedTasks?.length?w.confirmedTasks:w.proposedTasks.map(t=>'(proposed) '+t))):tpl.tasks.map(t=>'(template) '+t),parts:[...new Set(items.flatMap(w=>w.parts||[]))],
   serviceMinutes:inputs.visitMinutes?.[sid]??est,serviceUncertainty:inputs.visitMinutes?.[sid]?0:items.length?items.reduce((s,w)=>s+(w.uncertaintyMinutes||0),0):tpl.uncertaintyMinutes,estimateBasis:inputs.visitMinutes?.[sid]?'entered':items.length?(items.every(w=>w.estimateBasis==='entered')?'entered':'template default (unconfirmed)'):'template default (no work item)',
   taskClass:(items.length?items.map(w=>w.taskClass):[tpl.taskClass]).sort((a,b)=>CLASS_ORDER.indexOf(b)-CLASS_ORDER.indexOf(a))[0],requiredSkills:[...new Set(items.flatMap(w=>w.skills||[]))],accessWindows:n.accessWindows||items.find(w=>w.accessWindows)?.accessWindows||null,deferral:item.deferral||null,alreadyPlanned:planned.get(sid)||null};
  if(!Number.isFinite(lat)||!Number.isFinite(lon)){pre.push({stationId:sid,name:st.name,tier:c.tier,code:'no-location',reason:'Station has no valid coordinates.'});continue;}
  const d=distance(inputs.start,{lat,lon});
  if(d>maxKm&&!inputs.required.includes(sid)){pre.push({stationId:sid,name:st.name,tier:c.tier,incidentIds:c.incidentIds,code:'out-of-range',reason:`About ${Math.round(d)} km straight-line from the start — beyond a one-day round trip for this workday (shortlist only; not a driving estimate).`});continue;}
  candidates.push(c);
 }
 candidates.sort((a,b)=>{for(let i=0;i<a.priorityKey.length;i++){if(a.priorityKey[i]===b.priorityKey[i])continue;return typeof a.priorityKey[i]==='number'?a.priorityKey[i]-b.priorityKey[i]:String(a.priorityKey[i]).localeCompare(String(b.priorityKey[i]));}return 0;});
 const shortlisted=candidates.slice(0,MAX_MATRIX_POINTS-2);for(const c of candidates.slice(MAX_MATRIX_POINTS-2))pre.push({stationId:c.stationId,name:c.name,tier:c.tier,incidentIds:c.incidentIds,code:'capacity',reason:'Outside the bounded candidate set for this request (lower priority).'});
 const routing=routingStatus(env);let matrix=null,routingError=null;
 if(routing.configured&&shortlisted.length){try{matrix=await routeMatrix(env,[{id:'start',lat:inputs.start.lat,lon:inputs.start.lon},...shortlisted.map(c=>({id:c.id,lat:c.lat,lon:c.lon})),{id:'end',lat:inputs.end.lat,lon:inputs.end.lon}]);}catch(e){routingError=e.message;}}
 else if(!routing.configured)routingError=routing.setup;
 let forecasts={},alerts=[],forecastError=null;
 try{const fx=await forecastsFor(env,shortlisted.slice(0,24).map(c=>({id:c.stationId,lat:c.lat,lon:c.lon})));alerts=fx.alerts.alerts||[];const lo=localToUtc(inputs.date,'00:00').ms,hi=localToUtc(addDays(inputs.date,inputs.days),'00:00').ms;
  for(const [sid,f] of Object.entries(fx.forecasts))forecasts[sid]=f.forecast?{zones:f.zones,forecast:{...f.forecast,fields:Object.fromEntries(Object.entries(f.forecast.fields).map(([k,v])=>[k,v.filter(x=>x.end>lo&&x.start<hi)]))}}:{error:f.error};
  if(fx.alerts.error)forecastError='NWS alerts unavailable: '+fx.alerts.error;}
 catch(e){forecastError=e.message||'Forecast unavailable.';}
 const forecastEnd=Object.values(forecasts).map(f=>f.forecast?.validTo).filter(Boolean).sort()[0]||null;
 return {inputs,candidates:shortlisted,preExcluded:pre,matrix,routing:{...routing,error:routingError},forecasts,alerts,forecastError,forecastEnd,dates:planDates(inputs,forecastEnd),rules:inputs.rules,generatedAt:new Date().toISOString(),networkFetchedAt:network.fetchedAt,snapshot:{incidents:Object.fromEntries(q.queue.flatMap(i=>[i,...(i.members||[])]).map(i=>[i.id,{tier:i.effectiveTier,title:i.title,confidence:i.confidence}])),forecasts:Object.fromEntries(Object.entries(forecasts).map(([k,f])=>[k,{gridId:f.forecast?.gridId||null,updateTime:f.forecast?.updateTime||null,fetchedAt:f.forecast?.fetchedAt||null,error:f.error||null}])),matrix:matrix?{provider:matrix.provider,fetchedAt:matrix.fetchedAt,traffic:matrix.traffic}:null}};
}
function planSummary(result,inputs){return {stations:result.stops.map(s=>s.stationId),stops:result.stops.length,returnMs:result.returnMs,departMs:result.departMs,addressed:Object.fromEntries(Object.entries(result.addressed||{}).map(([k,v])=>[k,v.length])),weather:result.weatherSummary,driveMin:result.totals?.driveMin??null,distanceMi:result.totals?.distanceMi??null,feasible:result.feasible,crew:inputs.crew.label};}
async function computeAndStorePlan(env,user,{inputs,date,order,title,crew,existing,networkView}){
 const ctx=await planningContext(env,{...inputs,date,days:1},{excludePlanId:existing?.id,networkView});
 // Without road routing a trip can still be saved as an ordered list of stops; drive and arrival times stay blank.
 if(!ctx.matrix&&!order?.length)throw new AppError('A plan cannot be built without road routing: '+(ctx.routing.error||'routing unavailable'),503);
 const ordered=order?.length?order.map(id=>ctx.candidates.find(c=>c.stationId===id)).filter(Boolean):ctx.candidates;
 const result=ctx.matrix?planDay({inputs:{...ctx.inputs,manualOrder:order?.length?order:null},date,candidates:ctx.candidates,matrix:ctx.matrix,forecasts:ctx.forecasts,alerts:ctx.alerts}):unroutedDay({inputs:ctx.inputs,date,candidates:ordered,reason:ctx.routing.error});
 result.excluded=[...ctx.preExcluded,...result.excluded];
 const pts=[{label:inputs.start.label,lat:inputs.start.lat,lon:inputs.start.lon},...result.stops.map(s=>({label:s.name,lat:s.lat,lon:s.lon})),{label:inputs.end.label,lat:inputs.end.lat,lon:inputs.end.lon}];
 let geometry=null,geometryError=null;if(ctx.matrix&&result.stops.length){try{geometry=await routeGeometry(env,pts.map((p,i)=>({id:'p'+i,lat:p.lat,lon:p.lon})));}catch(e){geometryError=e.message;}}
 const plan={...(existing||{}),id:existing?.id||crypto.randomUUID(),status:existing?.status||'draft',date,crew:str(crew||inputs.crew.label,60),title:str(title,200)||`${inputs.crew.label} · ${date}`,version:PLANNER_VERSION,inputs:{...inputs,date,days:1,manualOrder:order||null},result,navigation:navigationLinks(pts),geometry,geometryError,routing:ctx.matrix?{provider:ctx.matrix.provider,fetchedAt:ctx.matrix.fetchedAt,traffic:ctx.matrix.traffic,attribution:ctx.matrix.attribution,synthetic:!!ctx.matrix.synthetic}:{provider:null,unavailable:true,reason:ctx.routing.error||'Road routing unavailable.'},forecast:{error:ctx.forecastError,end:ctx.forecastEnd},snapshot:ctx.snapshot,summary:planSummary(result,inputs),outdated:null};
 return plan;
}

// ---------- routes ----------
export async function fleetRoute(req,env,user,path,method,url,ctx){
 const parts=path.split('/').filter(Boolean);if(parts[0]!=='ops')return null;
 const actor=user.name||user.email,editorOnly=()=>{if(user.role==='viewer')throw new AppError('Your account has view-only access.',403);},ownerOnly=()=>{if(user.role!=='owner')throw new AppError('Only the owner can change fleet policy settings.',403);};
 const body=()=>ctx.parse(req,256*1024);
 // /ops/settings
 if(parts[1]==='settings'&&parts.length===2){
  if(method==='GET')return json({...await fleetSettings(env),taskClasses:TASK_CLASSES,routing:routingStatus(env),workflowStates:WORKFLOW_STATES,tiers:TIERS,tieBreakers:TIE_BREAKERS,coverageVariables:Object.fromEntries(Object.entries(COVERAGE_VARIABLES).map(([k,v])=>[k,v.label]))});
  if(method==='POST'){ownerOnly();const b=await body(),current=await fleetSettings(env),next=validateFleetSettings(b,current);await saveDoc(env.DB,'fleet-settings','settings',{...next,updatedBy:actor,updated:new Date().toISOString()});return json(await fleetSettings(env));}
 }
 if(parts[1]==='incidents'){
  if(parts.length===2&&method==='GET'){const state=['open','resolved','all'].includes(url.searchParams.get('state'))?url.searchParams.get('state'):'open',station=url.searchParams.get('station'),cursor=url.searchParams.get('cursor')||'';if(station&&!id(station))throw new AppError('Invalid station.');if(cursor&&!/^[0-9T:.\-Z]+\|[a-f0-9-]{36}$/.test(cursor))throw new AppError('Invalid cursor.');return json(await store.listIncidents(env.DB,{state,station,cursor,limit:50}));}
  const iid=parts[2];if(!uuid(iid))throw new AppError('Incident not found.',404);
  if(parts.length===3&&method==='GET'){const inc=await store.getIncident(env.DB,iid);if(!inc)throw new AppError('Incident not found.',404);const [events,work]=await Promise.all([store.incidentEvents(env.DB,iid),store.listWork(env.DB,{incident:iid})]);const members=inc.scope==='group'?(await Promise.all((inc.body.members||[]).map(async m=>({...m,incident:(await env.DB.prepare("SELECT id,tier,state,confidence,telemetry,assignee FROM incidents WHERE scope='station' AND station=? ORDER BY created DESC LIMIT 1").bind(m.id).first())||null})))):[];return json({incident:{...inc,effectiveTier:effectiveTier(inc),priorityReasons:priorityReasons({...inc,stationCount:(inc.body.stations||[]).length||1,sensorGroupCount:(inc.body.sensorGroups||[]).length,provisionalGrouping:inc.body.provisionalGrouping})},events,work,members,suggestedTemplates:suggestTemplates(inc)});}
  if(parts.length===3&&method==='PATCH'){editorOnly();const b=await body();return json(await store.patchIncident(env.DB,iid,b,actor));}
  if(parts.length===4&&['merge','split'].includes(parts[3])&&method==='POST'){editorOnly();const b=await body();if(parts[3]==='merge'&&!uuid(b.otherId))throw new AppError('Choose a group to merge.');if(parts[3]==='split'&&(!Array.isArray(b.stations)||b.stations.some(s=>!id(s))||!['standalone','new-group'].includes(b.mode||'standalone')))throw new AppError('Choose stations and a split mode.');return json(await store.regroupIncidents(env.DB,{action:parts[3],id:iid,...b},actor));}
 }
 if(parts[1]==='alerts'){
  if(parts.length===2&&method==='GET'){const cursor=url.searchParams.get('cursor')||'';if(cursor&&!/^[0-9T:.\-Z]+$/.test(cursor))throw new AppError('Invalid cursor.');return json(await store.listAlerts(env.DB,{open:url.searchParams.get('open')!=='0',cursor,limit:50}));}
  if(parts[2]==='ack'&&method==='POST'){const b=await body();return json(await store.acknowledgeAlerts(env.DB,b.ids,actor));}
 }
 if(parts[1]==='stations'&&parts.length===3&&method==='GET'){if(!id(parts[2]))throw new AppError('Unknown station.',404);return json(await stationDetail(env,user,parts[2],ctx));}
 if(parts[1]==='profiles'&&parts.length===4&&method==='PATCH'){editorOnly();if(!id(parts[2])||!/^[a-z0-9_]{1,80}$/.test(parts[3]))throw new AppError('Unknown sensor channel.',404);const b=await body();let patch;try{patch=validateProfileEdit(b);}catch(e){throw new AppError(e.message);}const reason=str(b.reason,300);if(reason.length<3)throw new AppError('Record why the sensor profile is changing.');const row=await store.updateProfileRow(env.DB,parts[2],parts[3],b.revision,{...patch,teamReason:reason},actor);await env.DB.prepare("INSERT INTO incident_events(id,incident_id,at,actor,type,detail) SELECT ?,id,?,?,?,? FROM incidents WHERE scope='station' AND station=? AND state NOT IN ('resolved','merged')").bind(crypto.randomUUID(),new Date().toISOString(),actor,'profile-changed',`${parts[3]}: ${JSON.stringify(patch).slice(0,300)} — ${reason}`,parts[2]).run();return json(row);}
 if(parts[1]==='notes'&&parts.length===3){if(!id(parts[2]))throw new AppError('Unknown station.',404);if(method==='GET')return json(redactNotes(await store.getStationNotes(env.DB,parts[2]),user));if(method==='PUT'){editorOnly();const b=await body(),clean=validateNotes(b);return json(await store.putStationNotes(env.DB,parts[2],clean,b.revision||null,actor));}}
 if(parts[1]==='reference-overrides'){
  if(parts.length===2&&method==='POST'){editorOnly();const b=await body();if(!id(b.station)||!id(b.reference)||!COVERAGE_VARIABLES[b.variable]||!['pin','exclude'].includes(b.action)||str(b.reason,500).length<3)throw new AppError('Choose a station, reference, variable, pin/exclude and a reason.');if(b.station===b.reference)throw new AppError('A station cannot reference itself.');return json(await store.addReferenceOverride(env.DB,{station:b.station,variable:b.variable,reference:b.reference,action:b.action,reason:str(b.reason,500)},actor),201);}
  if(parts.length===4&&parts[3]==='remove'&&method==='POST'){editorOnly();if(!uuid(parts[2]))throw new AppError('Override not found.',404);const b=await body();if(str(b.reason,500).length<3)throw new AppError('Record why the override is removed.');return json(await store.removeReferenceOverride(env.DB,parts[2],b.reason,actor));}
 }
 if(parts[1]==='work'){
  if(parts.length===2&&method==='GET'){const station=url.searchParams.get('station'),incident=url.searchParams.get('incident');if(station&&!id(station)||incident&&!uuid(incident))throw new AppError('Invalid filter.');return json({work:await store.listWork(env.DB,{station,incident,open:url.searchParams.get('open')==='1'}),templates:TEMPLATES});}
  if(parts.length===2&&method==='POST'){editorOnly();const b=await body();const incident=b.incidentId?await store.getIncident(env.DB,b.incidentId):null;if(b.incidentId&&!incident)throw new AppError('Incident not found.',404);const network=await ctx.networkView(env);if(!network.stations.some(s=>s.id===b.station))throw new AppError('Choose a station in the network inventory.');if(incident&&incident.scope==='station'&&incident.station!==b.station)throw new AppError('Work for a station incident must be at that station.');if(incident&&incident.scope==='group'&&!(incident.body.members||[]).some(m=>m.id===b.station))throw new AppError('Choose a member station of this group.');let w;try{w=newWorkItem(b,{incident,actor});}catch(e){throw new AppError(e.message);}return json(await store.insertWork(env.DB,w,actor),201);}
  const wid=parts[2];if(!uuid(wid))throw new AppError('Work item not found.',404);
  const w=await store.getWork(env.DB,wid);if(!w)throw new AppError('Work item not found.',404);
  if(parts.length===3&&method==='GET')return json(w);
  if(parts.length===3&&method==='PATCH'){editorOnly();const b=await body();if(!b.revision||b.revision!==w.revision)throw new AppError('This work item changed. Reload before saving.',409);let r;try{r=applyWorkPatch(w,b,{actor});}catch(e){throw new AppError(e.message);}return json(await store.updateWork(env.DB,r.item,w.revision,actor,`Work ${w.title}: ${r.summary}`+(r.item.status==='done'?' (work recorded; recovery is verified from telemetry)':'')));}
  if(parts.length===4&&parts[3]==='handoff'&&method==='GET'){const network=await ctx.networkView(env);return json(workHandoff(w,{stationName:network.stations.find(s=>s.id===w.station)?.name||w.station}));}
 }
 if(parts[1]==='routing'&&method==='GET')return json(routingStatus(env));
 if(parts[1]==='forecast'&&method==='GET'){const ids=(url.searchParams.get('stations')||'').split(',').filter(Boolean);if(!ids.length||ids.length>24||ids.some(x=>!id(x)))throw new AppError('Request forecasts for 1–24 stations.');const network=await ctx.networkView(env);const locs=ids.map(x=>network.stations.find(s=>s.id===x)).filter(s=>s&&Number.isFinite(s.lat)).map(s=>({id:s.id,lat:s.lat,lon:s.lon}));return json(await forecastsFor(env,locs));}
 if(parts[1]==='plans'){
  if(parts[2]==='preview'&&method==='POST'){editorOnly();await tripRate(env,user);const b=await body();
   const stops=Array.isArray(b.stops)?[...new Set(b.stops.filter(id))].slice(0,20):[];if(!stops.length)throw new AppError('Add at least one station to the trip.');
   let inputs;try{inputs=validatePlanInputs({...b.inputs,days:1,tiers:[],required:stops,includeDuplicates:stops,maxStops:20,manualOrder:b.optimize?null:stops});}catch(e){throw new AppError(e.message);}
   return json(await tripPreview(env,inputs,{stops,optimize:!!b.optimize,networkView:ctx.networkView}));}
  if(parts[2]==='context'&&method==='POST'){editorOnly();await planRate(env,user);const b=await body();let inputs;try{inputs=validatePlanInputs(b.inputs||{});}catch(e){throw new AppError(e.message);}return json(await planningContext(env,inputs,{networkView:ctx.networkView}));}
  if(parts.length===2&&method==='GET'){const from=url.searchParams.get('from'),to=url.searchParams.get('to');for(const d of [from,to])if(d&&!/^\d{4}-\d{2}-\d{2}$/.test(d))throw new AppError('Use YYYY-MM-DD dates.');return json({plans:await store.listPlans(env.DB,{from,to,limit:100})});}
  if(parts.length===2&&method==='POST'){editorOnly();await planRate(env,user);const b=await body();let inputs;try{inputs=validatePlanInputs({...b.inputs,date:b.date||b.inputs?.date});}catch(e){throw new AppError(e.message);}const order=Array.isArray(b.order)?b.order.filter(id).slice(0,20):null;const plan=await computeAndStorePlan(env,user,{inputs,date:inputs.date,order,title:b.title,crew:b.crew,networkView:ctx.networkView});const saved=await store.savePlan(env.DB,plan,null,actor,`Draft created: ${plan.result.stops.length} stops`);await linkPlanEvents(env,saved,actor,'planned');return json(saved,201);}
  const pid=parts[2];if(!uuid(pid))throw new AppError('Plan not found.',404);
  const plan=await store.getPlan(env.DB,pid);if(!plan)throw new AppError('Plan not found.',404);
  if(parts.length===3&&method==='GET'){const incidents=await store.openIncidents(env.DB),updates={},grids=new Map();
   // Compares saved forecast issue times with already-cached grids only; viewing a plan never triggers provider calls.
   for(const [sid,f] of Object.entries(plan.snapshot?.forecasts||{})){if(!f.gridId)continue;if(!grids.has(f.gridId))grids.set(f.gridId,(await cacheRead(env.DB,'nws:grid:'+f.gridId,{allowExpired:true}))?.body?.updateTime||null);updates[sid]=grids.get(f.gridId);}
   const outdated=['accepted','draft'].includes(plan.status)?planOutdated(plan,{incidents,forecastUpdates:updates}):[];return json({...plan,outdated,revisions:await store.planRevisions(env.DB,pid)});}
  if(parts.length===3&&method==='PATCH'){editorOnly();const b=await body();if(!b.revision||b.revision!==plan.revision)throw new AppError('This plan changed. Reload it; your edits have not been applied.',409);
   let next={...plan},summary=[];
   if(b.status!==undefined){if(!['draft','accepted','completed','cancelled'].includes(b.status))throw new AppError('Choose a plan status.');if(b.status==='accepted'&&!plan.result?.feasible){if(str(b.overrideReason,500).length<3)throw new AppError('This trip breaks a constraint (see the warnings). Record why it is being accepted anyway.');next.acceptOverride={reason:str(b.overrideReason,500),by:actor,at:new Date().toISOString(),violations:(plan.result.violations||[]).map(v=>v.reason)};}if(b.status==='completed'&&str(b.completionNote,2000).length<3)throw new AppError('Record a completion note (what was visited). Telemetry recovery is tracked separately.');next.status=b.status;summary.push('Status '+b.status);if(b.status==='completed')next.completion={note:str(b.completionNote,2000),by:actor,at:new Date().toISOString()};if(b.status==='accepted')next.acceptedAt=new Date().toISOString();}
   if(b.title!==undefined){next.title=str(b.title,200)||plan.title;summary.push('Title');}
   if(b.deferrals!==undefined){if(!Array.isArray(b.deferrals)||b.deferrals.some(d=>!id(d.stationId)||str(d.reason,500).length<3))throw new AppError('Record a reason for each deliberate deferral.');next.deferrals=b.deferrals.map(d=>({stationId:d.stationId,reason:str(d.reason,500),by:actor,at:new Date().toISOString()}));summary.push('Deferral reasons');}
   if(b.order!==undefined||b.inputs!==undefined){if(plan.status!=='draft')throw new AppError('Accepted plans are never rewritten. Copy it to a new draft to change stops.');let inputs;try{inputs=validatePlanInputs({...plan.inputs,...(b.inputs||{}),date:plan.date});}catch(e){throw new AppError(e.message);}const order=Array.isArray(b.order)?b.order.filter(id).slice(0,20):plan.inputs.manualOrder;const recomputed=await computeAndStorePlan(env,user,{inputs,date:plan.date,order,title:next.title,crew:next.crew,existing:next,networkView:ctx.networkView});next={...recomputed,status:'draft',deferrals:next.deferrals};summary.push('Recomputed');}
   if(!summary.length)throw new AppError('No changes to save.');
   const saved=await store.savePlan(env.DB,next,plan.revision,actor,summary.join(', '));if(b.status)await linkPlanEvents(env,saved,actor,b.status);return json(saved);}
  if(parts.length===4&&parts[3]==='copy'&&method==='POST'){editorOnly();const copy={...plan,id:crypto.randomUUID(),status:'draft',title:plan.title+' (copy)',acceptedAt:null,completion:null,created:null,createdBy:null};return json(await store.savePlan(env.DB,copy,null,actor,'Copied from '+plan.id),201);}
  if(parts.length===4&&parts[3]==='export'&&method==='GET'){const format=url.searchParams.get('format');if(format==='csv'){const rows=[['order','station_id','station','tier','arrive_local','service_start_local','service_end_local','depart_local','drive_min','distance_km','weather','tasks','parts','warnings']];const f=ms=>new Date(ms).toLocaleString('en-US',{timeZone:'America/Detroit',hour12:false});for(const s of plan.result.stops)rows.push([s.order,s.stationId,s.name,s.tier,f(s.arriveMs),f(s.serviceStartMs),f(s.serviceEndMs),f(s.departMs),s.driveMin,s.distanceKm,s.weather.status,s.tasks.join(' | '),s.parts.join(' | '),s.warnings.join(' | ')]);const csv=rows.map(r=>r.map(v=>{const t=String(v??'');return /^[=+\-@]/.test(t)?`"'${t.replace(/"/g,'""')}"`:/[",\n]/.test(t)?`"${t.replace(/"/g,'""')}"`:t;}).join(',')).join('\n')+'\n';return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store'}});}return json({schemaVersion:1,kind:'enviroweather-field-plan',exportedAt:new Date().toISOString(),plan});}
 }
 if(parts[1]==='export'&&method==='GET'){
  const kinds=['incidents','work','plans','notes','profiles','overrides'],kind=url.searchParams.get('kind')||'incidents',offset=Number(url.searchParams.get('offset')||0);if(!kinds.includes(kind)||!Number.isInteger(offset)||offset<0||offset>1e6)throw new AppError('Invalid export page.');
  const q={incidents:'SELECT * FROM incidents ORDER BY created,id',work:'SELECT * FROM work_items ORDER BY created,id',plans:'SELECT * FROM plans ORDER BY created,id',notes:'SELECT station,body,revision,updated,updated_by FROM station_notes ORDER BY station',profiles:null,overrides:'SELECT * FROM reference_overrides ORDER BY at,id'}[kind];
  const limit=kind==='profiles'?500:100,{results}=kind==='profiles'?{results:Object.entries((await store.loadProfiles(env.DB)).stations).flatMap(([station,rows])=>rows.map(r=>({...r,station}))).slice(offset,offset+limit+1)}:await env.DB.prepare(q+' LIMIT ? OFFSET ?').bind(limit+1,offset).all();
  let rows=results.slice(0,limit);
  if(kind==='incidents')rows=await Promise.all(rows.map(async r=>({...store.incidentFromRow(r),events:await store.incidentEvents(env.DB,r.id,500)})));
  else if(kind==='work')rows=rows.map(store.workFromRow);else if(kind==='plans')rows=rows.map(store.planFromRow);
  else if(kind==='notes')rows=rows.map(r=>redactNotes({...JSON.parse(r.body),station:r.station,revision:r.revision,updated:r.updated,updatedBy:r.updated_by},user));

  const next=results.length>limit?{kind,offset:offset+limit}:kinds.indexOf(kind)<kinds.length-1?{kind:kinds[kinds.indexOf(kind)+1],offset:0}:null;
  return json({schemaVersion:1,kind:'enviroweather-fleet-operations-export',exportedAt:new Date().toISOString(),page:{kind,offset},rows,next});
 }
 throw new AppError('Endpoint not found.',404);
}
// Trip previews recompute on every edit; matrices are cached by stop set, so reordering does not spend routing quota.
async function tripPreview(env,inputs,{stops,optimize,networkView}){
 const ctx=await planningContext(env,inputs,{networkView});
 const byStop=new Map(ctx.candidates.map(c=>[c.stationId,c]));
 const candidates=stops.map(s=>byStop.get(s)).filter(Boolean);
 const result=ctx.matrix?planDay({inputs:{...ctx.inputs,manualOrder:optimize?null:candidates.map(c=>c.stationId)},date:inputs.date,candidates,matrix:ctx.matrix,forecasts:ctx.forecasts,alerts:ctx.alerts}):unroutedDay({inputs:ctx.inputs,candidates,reason:ctx.routing.error||'Road routing unavailable.'});
 result.excluded=[...ctx.preExcluded,...result.excluded];
 const pts=[{id:'start',label:inputs.start.label,lat:inputs.start.lat,lon:inputs.start.lon},...result.stops.map(x=>({id:x.stationId,label:x.name,lat:x.lat,lon:x.lon})),{id:'end',label:inputs.end.label,lat:inputs.end.lat,lon:inputs.end.lon}];
 let geometry=null,geometryError=null;
 if(ctx.matrix&&result.stops.length){try{geometry=await routeGeometry(env,pts.map((p,i)=>({id:'p'+i,lat:p.lat,lon:p.lon})));}catch(e){geometryError=e.message;}}
 return {generatedAt:new Date().toISOString(),inputs:ctx.inputs,order:result.stops.map(x=>x.stationId),candidates:candidates.map(c=>({stationId:c.stationId,name:c.name,lat:c.lat,lon:c.lon,tier:c.tier,serviceMinutes:c.serviceMinutes,estimateBasis:c.estimateBasis,taskClass:c.taskClass,incidentIds:c.incidentIds,workItemIds:c.workItemIds,entranceKnown:c.entranceKnown})),result,geometry,geometryError,navigation:result.stops.length?navigationLinks(pts):null,routing:{...ctx.routing,matrixFetchedAt:ctx.matrix?.fetchedAt||null,cached:!!ctx.matrix?.cached,provider:ctx.matrix?.provider||ctx.routing.provider},forecast:{error:ctx.forecastError,end:ctx.forecastEnd},networkFetchedAt:ctx.networkFetchedAt};
}
async function tripRate(env,user){const key='trip:'+user.id,now=Date.now();const row=await env.DB.prepare('INSERT INTO attempts (key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count').bind(key,now+3600000,now,now).first();if(row.count>240)throw new AppError('Trip calculation limit reached (240 per hour) to protect routing and forecast quotas. Saved trips remain available.',429);}
async function planRate(env,user){const key='plan:'+user.id,now=Date.now();const row=await env.DB.prepare('INSERT INTO attempts (key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count').bind(key,now+3600000,now,now).first();if(row.count>60)throw new AppError('Planning limit reached (60 per hour) to protect routing and forecast quotas. Saved plans remain available.',429);}
async function linkPlanEvents(env,plan,actor,status){
 const ids=[...new Set((plan.result?.stops||[]).flatMap(s=>s.incidentIds))].filter(uuid).slice(0,40);if(!ids.length)return;
 const now=new Date().toISOString();await env.DB.batch(ids.map(i=>store.eventStatement(env.DB,{incidentId:i,at:now,actor,type:'plan-'+status,detail:`${plan.title} (${plan.date}) ${status}.`})));
}
