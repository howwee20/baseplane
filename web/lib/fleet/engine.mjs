// Incident engine: applies persistence/recovery hysteresis over NEW successful ingests, keeps stable incident
// identity, groups simultaneous outages, and emits deduplicated alerts. Pure: callers load and persist state.
import {clusterOutages,GROUPING_DEFAULTS} from './grouping.mjs';
import {PRIORITY_VERSION,effectiveTier,tierRank} from './priority.mjs';
export const ENGINE_VERSION='fleet-engine-v1';
export const FLEET_DEFAULTS={outageConfirmCount:2,recoveryConfirmCount:2,sensorConfirmCount:2,reopenWindowHours:24,channelLagMinutes:90,retiredAfterDays:30,provisionalAfterHours:24,massOutageFraction:0.5,alertCapPerIngest:12,grouping:GROUPING_DEFAULTS};
export const WORKFLOW_STATES=['new','acknowledged','investigating','planned','in_progress','awaiting_parts','awaiting_access','monitoring','resolved'];
export const OPEN=s=>s!=='resolved'&&s!=='merged';
const OUT=['suspected','confirmed'];
const iso=ms=>ms===null||ms===undefined?null:new Date(ms).toISOString();
const later=(a,b)=>!a?b:!b?a:Date.parse(a)>=Date.parse(b)?a:b;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function initialStationState(station){return {station,reporting:'unknown',outageCount:0,recoveryCount:0,firstSuspectedAt:null,firstConfirmedAt:null,lastGoodAt:null,lastAssessedAt:null,lastIngestId:null,recoveredAt:null,feedHeld:false,sensor:{keys:[],count:0,recoveryCount:0,firstSeenAt:null,confirmed:false}};}

// Advances one station's state for one ingest. Re-processing the same ingest id returns the prior state unchanged.
export function advanceStation(prev,a,ingest,config=FLEET_DEFAULTS){
 const c={...FLEET_DEFAULTS,...config},p=prev||initialStationState(a.stationId);
 if(p.lastIngestId&&p.lastIngestId===ingest.id)return {...p,repeat:true};
 const s=structuredClone({...p,repeat:false}),at=ingest.retrievedAt;
 s.lastIngestId=ingest.id;s.lastAssessedAt=at;s.lastGoodAt=later(p.lastGoodAt,a.newest);
 // Absence of data counts as evidence only from a complete provider snapshot that included this station.
 const absenceCounts=ingest.quality==='complete'&&a.reporting!=='not-in-response';
 const silent=a.reporting==='outage-candidate'||a.reporting==='no-data'&&!!s.lastGoodAt;
 if(['inactive','maintenance'].includes(a.reporting)){Object.assign(s,{reporting:a.reporting,outageCount:0,recoveryCount:0,feedHeld:false});s.sensor={keys:[],count:0,recoveryCount:0,firstSeenAt:null,confirmed:false};return s;}
 if(a.reporting==='not-in-response'){s.feedHeld=true;return s;}
 if(silent){
  const wasOut=[...OUT,'recovering'].includes(p.reporting);
  s.outageCount=absenceCounts?(wasOut?p.outageCount:0)+1:wasOut?p.outageCount:0;
  s.feedHeld=!absenceCounts;s.recoveryCount=0;
  s.reporting=s.outageCount>=c.outageConfirmCount?'confirmed':'suspected';
  if(!wasOut)s.firstSuspectedAt=at;
  if(s.reporting==='confirmed'&&!s.firstConfirmedAt)s.firstConfirmedAt=at;
  return s;
 }
 if(a.reporting==='no-data'){Object.assign(s,{reporting:'no-data',outageCount:0,feedHeld:false});return s;}
 s.feedHeld=false;
 if(p.reporting==='suspected'){Object.assign(s,{reporting:a.reporting,outageCount:0,recoveryCount:0,firstSuspectedAt:null});}
 else if(['confirmed','recovering'].includes(p.reporting)){
  s.recoveryCount=(p.reporting==='recovering'?p.recoveryCount:0)+1;
  if(s.recoveryCount>=c.recoveryConfirmCount)Object.assign(s,{reporting:a.reporting,recoveredAt:at,outageCount:0,recoveryCount:0,firstSuspectedAt:null,firstConfirmedAt:null});
  else s.reporting='recovering';
 }else s.reporting=a.reporting;
 if(s.reporting==='recovering')return s;
 // Sensor issues are tracked only while the station is reporting; a full outage freezes them.
 const keys=[...a.issueKeys].sort();
 if(keys.length){
  s.sensor.count=absenceCounts?(p.sensor.keys.length?p.sensor.count:0)+1:p.sensor.keys.length?p.sensor.count:0;
  s.sensor.keys=keys;s.sensor.recoveryCount=0;s.sensor.firstSeenAt=p.sensor.keys.length?p.sensor.firstSeenAt:at;
  s.sensor.confirmed=s.sensor.confirmed||s.sensor.count>=c.sensorConfirmCount;
 }else if(p.sensor.keys.length){
  if(!p.sensor.confirmed)s.sensor={keys:[],count:0,recoveryCount:0,firstSeenAt:null,confirmed:false};
  else{s.sensor.recoveryCount=p.sensor.recoveryCount+1;if(s.sensor.recoveryCount>=c.recoveryConfirmCount)s.sensor={keys:[],count:0,recoveryCount:0,firstSeenAt:null,confirmed:false,recoveredAt:at};}
 }
 return s;
}

function newIncident(fields,ids,at){return {id:ids(),tierOverride:null,assignee:null,acknowledgedBy:null,acknowledgedAt:null,firstSuspected:at,firstConfirmed:null,lastGood:null,lastAssessed:at,recoveredAt:null,resolvedAt:null,resolution:null,deferral:null,revision:null,created:at,updated:at,algorithm:`${ENGINE_VERSION}+${PRIORITY_VERSION}`,groupId:null,station:null,...fields,body:{title:'',stations:[],members:[],channels:[],sensorGroups:[],provisionalGrouping:false,reasonCodes:[],reasons:[],evidence:null,overrides:{pinned:[],excluded:[],locked:false},optOutGrouping:false,recurrence:0,mergedInto:null,formerGroupId:null,...fields.body},_new:true,_changed:true,_bump:true};}

// Reconciles incidents for one ingest. Returns changed station states, incidents, audit events and alerts.
export function runEngine({ingest,assessments=[],stationStates={},incidents=[],config=FLEET_DEFAULTS,context={},ids=()=>crypto.randomUUID()}){
 const c={...FLEET_DEFAULTS,...config,grouping:{...GROUPING_DEFAULTS,...config.grouping}},at=ingest.retrievedAt,events=[],alerts=[],states={},byStation=new Map(),groups=[];
 const work=incidents.map(i=>({...structuredClone(i),_changed:false,_bump:false,_start:{tier:effectiveTier(i),confidence:i.confidence,state:i.state}}));
 const reopenAfter=Date.parse(at)-c.reopenWindowHours*36e5;
 const event=(inc,type,detail)=>events.push({id:ids(),incidentId:inc.id,at,actor:'system',type,detail,ingestId:ingest.id});
 const alert=(inc,kind,title,detail,key)=>alerts.push({id:ids(),dedupe:key,incidentId:inc?.id||null,kind,tier:inc?effectiveTier(inc):null,title,detail,created:at});
 const touch=(inc,bump=false)=>{inc._changed=true;inc.updated=at;if(bump)inc._bump=true;};
 const feedOpen=work.find(i=>i.scope==='feed'&&OPEN(i.state));

 // Feed health first: a failed or degraded snapshot is a data-service incident, never dozens of station failures.
 if(ingest.status==='failed'||['partial','degraded'].includes(ingest.quality)){
  const reasons=ingest.reasons?.length?ingest.reasons:['Provider refresh failed; showing the last good snapshot.'];
  if(feedOpen){if(!same(feedOpen.body.reasons,reasons)){feedOpen.body.reasons=reasons;touch(feedOpen);}feedOpen.lastAssessed=at;feedOpen._changed=true;}
  else{const inc=newIncident({scope:'feed',kind:ingest.status==='failed'?'provider-failure':'provider-degraded',tier:'FEED',state:'new',confidence:'confirmed',telemetry:'down',body:{title:'Weather data service problem',reasons}},ids,at);work.push(inc);event(inc,'created',reasons.join(' '));alert(inc,'feed','Weather data feed problem',reasons.join(' '),`feed:${inc.id}`);}
 }else if(feedOpen){Object.assign(feedOpen,{state:'resolved',telemetry:'recovered',resolvedAt:at,resolution:'feed-recovered'});touch(feedOpen,true);event(feedOpen,'resolved','A complete provider snapshot was ingested.');alert(feedOpen,'feed-recovered','Weather data feed recovered','A complete provider snapshot was ingested.',`feed:${feedOpen.id}:recovered`);}
 if(ingest.status==='failed')return finish();

 for(const a of assessments){
  const prev=stationStates[a.stationId],next=advanceStation(prev,a,ingest,c);
  if(!next.repeat)states[a.stationId]=next;
  byStation.set(a.stationId,{a,s:next});
 }
 if(assessments.length&&assessments.every(a=>byStation.get(a.stationId).s.repeat))return finish();

 // Station incidents: one open incident per station whose kind escalates/de-escalates in place.
 for(const [station,{a,s}] of byStation){
  if(s.repeat)continue;
  let inc=work.find(i=>i.scope==='station'&&i.station===station&&OPEN(i.state));
  const outage=[...OUT,'recovering'].includes(s.reporting),sensor=!outage&&(s.sensor.keys.length>0);
  if(!outage&&!sensor){
   if(inc){
    const confirmed=inc.confidence==='confirmed';
    Object.assign(inc,{state:'resolved',telemetry:'recovered',recoveredAt:at,resolvedAt:at,resolution:confirmed?'telemetry-recovered':'cleared-before-confirmation'});
    touch(inc,true);event(inc,'resolved',confirmed?`Telemetry recovered and held for ${c.recoveryConfirmCount} new snapshots.`:'Cleared before confirmation.');
    if(confirmed&&!inc.groupId)alert(inc,'recovered',`${a.name} recovered`,'Telemetry recovered; confirm any field work separately.',`${inc.id}:recovered:${inc.body.recurrence}`);
   }
   continue;
  }
  if(!inc){
   const recent=work.filter(i=>i.scope==='station'&&i.station===station&&i.state==='resolved'&&Date.parse(i.resolvedAt||0)>=reopenAfter).sort((x,y)=>Date.parse(y.resolvedAt)-Date.parse(x.resolvedAt))[0];
   if(recent){inc=recent;const manual=recent.resolution&&!['telemetry-recovered','cleared-before-confirmation'].includes(recent.resolution);Object.assign(inc,{state:'new',resolvedAt:null,resolution:null,recoveredAt:null,acknowledgedBy:null,acknowledgedAt:null});inc.body.recurrence=(inc.body.recurrence||0)+1;touch(inc,true);event(inc,'reopened',manual?'Issue still observed after manual resolution.':`Issue recurred within ${c.reopenWindowHours} hours.`);}
   else{inc=newIncident({scope:'station',kind:outage?'outage':'sensor',station,tier:outage?'P2':'P4',state:'new',confidence:'suspected',telemetry:'down',body:{title:a.name}},ids,at);work.push(inc);event(inc,'created',a.reasons.join(' '));}
  }
  const kind=outage?'outage':'sensor',confidence=outage?(s.reporting==='suspected'?'suspected':'confirmed'):(s.sensor.confirmed?'confirmed':'suspected');
  const groupsAffected=outage?[]:a.issueGroups,tier=outage?'P2':groupsAffected.length>1?'P3':'P4';
  if(inc.kind!==kind){event(inc,kind==='outage'?'escalated':'de-escalated',kind==='outage'?'Station stopped reporting entirely.':'Station reporting again; some expected sensors remain missing.');inc.kind=kind;touch(inc,true);}
  if(inc.confidence!==confidence){if(confidence==='confirmed'){inc.firstConfirmed=inc.firstConfirmed||at;event(inc,'confirmed',kind==='outage'?`No data in ${s.outageCount} consecutive new snapshots.`:`Sensor issue persisted in ${s.sensor.count} consecutive new snapshots.`);}inc.confidence=confidence;touch(inc,true);}
  const telemetry=s.reporting==='recovering'?'recovering':'down';if(inc.telemetry!==telemetry){event(inc,telemetry==='recovering'?'telemetry-recovering':'telemetry-down',telemetry==='recovering'?'Station reporting again; awaiting recovery confirmation.':'Telemetry down again.');inc.telemetry=telemetry;touch(inc,true);}
  const prevTier=inc.tier;if(prevTier!==tier){inc.tier=tier;touch(inc,true);if(tierRank(tier)<tierRank(prevTier))event(inc,'escalated',`Tier ${prevTier} → ${tier}.`);}
  const channels=outage?[]:a.issueKeys,body=inc.body;
  if(!same(body.channels,channels)||!same(body.sensorGroups,groupsAffected.map(g=>({id:g.id,label:g.label,provisional:g.provisional,channels:g.channels})))){if(body.channels.length&&!outage)event(inc,'channels-changed',`Affected channels: ${channels.join(', ')||'none'}.`);body.channels=channels;body.sensorGroups=groupsAffected.map(g=>({id:g.id,label:g.label,provisional:g.provisional,channels:g.channels}));body.provisionalGrouping=groupsAffected.some(g=>g.provisional);touch(inc);}
  body.stations=[station];body.title=a.name;body.reasonCodes=a.reasonCodes;body.reasons=a.reasons;body.feedHeld=s.feedHeld;
  body.evidence={ingestId:ingest.id,retrievedAt:at,feedQuality:ingest.quality,reporting:a.reporting,newest:a.newest,ageMinutes:a.ageMinutes,expectedCount:a.expectedCount,reportingCount:a.reportingCount,outageCount:s.outageCount,recoveryCount:s.recoveryCount,sensorCount:s.sensor.count,affected:a.channels.filter(ch=>channels.includes(ch.channel)||outage&&ch.expected).slice(0,40).map(ch=>({channel:ch.channel,state:ch.state,time:ch.time,unit:ch.unit}))};
  // For a sensor issue the relevant "last good" is when the affected sensor last reported, not the station.
  const affectedTimes=outage?[]:a.channels.filter(ch=>channels.includes(ch.channel)&&ch.time).map(ch=>Date.parse(ch.time)).filter(Number.isFinite);
  const sensorLast=affectedTimes.length?new Date(Math.max(...affectedTimes)).toISOString():null;
  inc.lastGood=outage?s.lastGoodAt:sensorLast||s.sensor.firstSeenAt||s.lastGoodAt;inc.firstSuspected=inc.firstSuspected||at;inc.lastAssessed=at;inc._changed=true;
  // Uncertainty of onset: somewhere between the last good observation and the first snapshot that lacked data.
  body.onset={earliest:outage?s.lastGoodAt:sensorLast,latest:outage?s.firstSuspectedAt:s.sensor.firstSeenAt};
 }

 // Group outages among fully non-reporting stations.
 const openGroups=work.filter(i=>i.scope==='group'&&OPEN(i.state));
 const candidates=[...byStation.values()].filter(({s})=>OUT.includes(s.reporting)).map(({a,s})=>({id:a.stationId,lat:a.lat,lon:a.lon,onset:Date.parse(s.lastGoodAt||s.firstSuspectedAt||at)})).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon));
 const optOut=work.filter(i=>i.scope==='station'&&OPEN(i.state)&&i.body.optOutGrouping).map(i=>i.station);
 const seeds=openGroups.map(g=>({groupId:g.id,members:[...new Set([...g.body.members.filter(m=>m.status==='out').map(m=>m.id),...g.body.overrides.pinned])],locked:g.body.overrides.locked,excluded:g.body.overrides.excluded}));
 const clusters=clusterOutages(candidates,c.grouping,{seeds,regions:context.regions||{},dependencies:context.dependencies||{},optOut});
 const stationInc=id=>work.find(i=>i.scope==='station'&&i.station===id&&OPEN(i.state));
 const activeGroupOf=new Map();
 for(const cl of clusters){
  let g=cl.seedGroupId?work.find(i=>i.id===cl.seedGroupId):null;
  if(!g&&cl.belowMinimum)continue;
  if(!g){
   const recent=work.filter(i=>i.scope==='group'&&i.state==='resolved'&&Date.parse(i.resolvedAt||0)>=reopenAfter&&i.body.members.some(m=>cl.members.includes(m.id))).sort((x,y)=>Date.parse(y.resolvedAt)-Date.parse(x.resolvedAt))[0];
   if(recent){g=recent;Object.assign(g,{state:'new',resolvedAt:null,resolution:null,recoveredAt:null});g.body.recurrence=(g.body.recurrence||0)+1;touch(g,true);event(g,'reopened','Group outage recurred.');}
   else{g=newIncident({scope:'group',kind:'group-outage',tier:'P1',state:'new',confidence:'suspected',telemetry:'down',body:{title:'Group outage'}},ids,at);work.push(g);event(g,'created',`${cl.members.length} stations stopped reporting within ${cl.onsetSpanMinutes??'unknown'} minutes, ${Math.round(cl.diameterKm)} km apart at most.`);}
  }
  groups.push(g);
  const now=new Set(cl.members),members=g.body.members;
  for(const id of cl.members){const m=members.find(x=>x.id===id);if(!m){members.push({id,status:'out',joinedAt:at,leftAt:null});event(g,'member-added',`${id} added (${cl.links.find(l=>l.station===id)?.dependency?'team-recorded shared dependency':'distance and onset criteria'}).`);touch(g,true);}else if(m.status!=='out'){m.status='out';m.leftAt=null;event(g,'member-out',`${id} out again.`);touch(g,true);}}
  for(const m of members)if(m.status==='out'&&!now.has(m.id)){const st=byStation.get(m.id)?.s;m.status=st?.reporting==='recovering'?'recovering':st&&OUT.includes(st.reporting)?'separated':'recovered';m.leftAt=at;event(g,'member-'+m.status,`${m.id} ${m.status==='separated'?'no longer meets grouping criteria':m.status}.`);touch(g,true);}
  for(const m of members)if(m.status==='recovering'){const st=byStation.get(m.id)?.s;if(st&&!['recovering',...OUT].includes(st.reporting)){m.status='recovered';m.leftAt=at;event(g,'member-recovered',`${m.id} recovered.`);touch(g);}}
  while(members.length>200)members.splice(members.findIndex(m=>m.status!=='out'),1);
  const active=members.filter(m=>m.status==='out').map(m=>m.id),confirmed=active.filter(id=>byStation.get(id)?.s.reporting==='confirmed');
  g.body.stations=active;g.body.title=`Group outage · ${active.length} station${active.length===1?'':'s'}`;
  g.body.reasons=[`${active.length} active stations not reporting; onset spread ${cl.onsetSpanMinutes??'unknown'} min; span ${Math.round(cl.diameterKm)} km.`,'A shared cause (power, carrier, modem) is not established by this grouping.'];
  g.body.reasonCodes=['group-outage'];g.body.geometry={diameterKm:Math.round(cl.diameterKm*10)/10,onsetSpanMinutes:cl.onsetSpanMinutes};
  g.body.onset={earliest:iso(cl.earliestOnset),latest:iso(cl.latestOnset)};g.lastGood=iso(cl.earliestOnset);g.lastAssessed=at;g._changed=true;
  if(active.length>=c.grouping.minGroupSize){
   const conf=confirmed.length>=c.grouping.minGroupSize?'confirmed':'suspected';
   if(g.confidence!==conf||g._start?.state==='resolved'&&!g._alertedReopen){if(g.confidence!==conf&&conf==='confirmed'){g.firstConfirmed=g.firstConfirmed||at;event(g,'confirmed',`${confirmed.length} member stations confirmed out.`);}g.confidence=conf;touch(g,true);if(conf==='confirmed'){g._alertedReopen=true;alert(g,'new',`Group outage: ${active.length} stations`,active.join(', '),`${g.id}:new:${g.body.recurrence||0}`);g.body.alertedPeak=Math.max(g.body.alertedPeak||0,active.length);}}
   if(g.telemetry!=='down'){g.telemetry='down';touch(g,true);}
   g.body.peak=Math.max(g.body.peak||0,active.length);
   if(conf==='confirmed'&&g.body.alertedPeak&&active.length>g.body.alertedPeak){alert(g,'expanded',`Group outage expanded to ${active.length} stations`,active.join(', '),`${g.id}:expanded:${active.length}:${g.body.recurrence||0}`);g.body.alertedPeak=active.length;touch(g);}
   for(const id of active)activeGroupOf.set(id,g.id);
  }else{
   const out=members.some(m=>m.status==='out'||m.status==='recovering');
   if(out){if(g.telemetry!=='partial-recovery'){g.telemetry='partial-recovery';event(g,'partial-recovery','Fewer than two members remain out; any remaining station is tracked as a single-station outage.');touch(g,true);}}
   else{Object.assign(g,{state:'resolved',telemetry:'recovered',recoveredAt:at,resolvedAt:at,resolution:'telemetry-recovered'});touch(g,true);event(g,'resolved','All member stations recovered.');if(g.confidence==='confirmed')alert(g,'recovered','Group outage recovered','All member stations reporting.',`${g.id}:recovered:${g.body.recurrence||0}`);}
  }
 }
 // Open groups that no cluster referenced (no member still out) also need closing or partial status.
 for(const g of openGroups)if(!groups.includes(g)){
  for(const m of g.body.members)if(m.status==='out'){const st=byStation.get(m.id)?.s;m.status=st?.reporting==='recovering'?'recovering':'recovered';m.leftAt=at;event(g,'member-'+m.status,`${m.id} ${m.status}.`);}
  for(const m of g.body.members)if(m.status==='recovering'&&byStation.get(m.id)?.s&&!['recovering',...OUT].includes(byStation.get(m.id).s.reporting)){m.status='recovered';m.leftAt=at;}
  const pending=g.body.members.some(m=>m.status==='recovering');
  if(pending){if(g.telemetry!=='recovering'){g.telemetry='recovering';touch(g,true);event(g,'telemetry-recovering','Members reporting again; awaiting recovery confirmation.');}}
  else{Object.assign(g,{state:'resolved',telemetry:'recovered',recoveredAt:at,resolvedAt:at,resolution:'telemetry-recovered'});touch(g,true);event(g,'resolved','All member stations recovered.');if(g.confidence==='confirmed')alert(g,'recovered','Group outage recovered','All member stations reporting.',`${g.id}:recovered:${g.body.recurrence||0}`);}
  g.body.stations=g.body.members.filter(m=>m.status==='out').map(m=>m.id);g._changed=true;
 }
 // Link member station incidents; tier P1 inherited while the group is active.
 for(const inc of work.filter(i=>i.scope==='station'&&OPEN(i.state))){
  const gid=inc.kind==='outage'?activeGroupOf.get(inc.station)||null:null;
  if(inc.groupId!==gid){
   if(gid){event(inc,'grouped',`Joined group outage ${gid}.`);}else if(inc.groupId){inc.body.formerGroupId=inc.groupId;event(inc,'ungrouped','Tracked as a single-station incident.');}
   inc.groupId=gid;touch(inc,true);
  }
  const tier=gid?'P1':inc.kind==='outage'?'P2':inc.tier;
  if(inc.tier!==tier){const before=inc.tier;inc.tier=tier;touch(inc,true);event(inc,tierRank(tier)<tierRank(before)?'escalated':'de-escalated',`Tier ${before} → ${tier}.`);}
 }
 // Alerts fire on transitions only: newly confirmed (or reopened and confirmed) and escalations.
 // Group members alert through their group; nothing alerts from a degraded snapshot.
 if(ingest.quality==='complete')for(const inc of work.filter(i=>i.scope==='station'&&OPEN(i.state)&&i.confidence==='confirmed'&&!i.groupId)){
  const tier=effectiveTier(inc),start=inc._start;
  if(!start||start.confidence!=='confirmed'||start.state==='resolved')alert(inc,'new',`${tier} · ${inc.body.title}`,inc.body.reasons.join(' '),`${inc.id}:new:${inc.body.recurrence||0}`);
  else if(tierRank(tier)<tierRank(start.tier))alert(inc,'escalated',`Escalated to ${tier} · ${inc.body.title}`,inc.body.reasons.join(' '),`${inc.id}:escalated:${tier}:${inc.body.recurrence||0}`);
 }
 return finish();

 function finish(){
  // One alert per dedupe key; a storm guard keeps the highest tiers and summarizes the rest.
  const unique=[...new Map(alerts.map(a=>[a.dedupe,a])).values()].sort((x,y)=>tierRank(x.tier)-tierRank(y.tier));
  if(unique.length>c.alertCapPerIngest){const rest=unique.slice(c.alertCapPerIngest-1);for(const a of rest)a.suppressed=true;unique.push({id:ids(),dedupe:`summary:${ingest.id}`,incidentId:null,kind:'summary',tier:null,title:`${rest.length} more incident updates`,detail:'Open the queue for the full list.',created:at});}
  for(const i of work){delete i._start;delete i._alertedReopen;}
  return {stationStates:states,incidents:work.filter(i=>i._changed),events,alerts:unique,feedQuality:ingest.quality};
 }
}
