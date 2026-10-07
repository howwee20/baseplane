// Builds the canonical work queue shown on the overview, Daily review, exports and planner.
// Group members are nested under their group, so each tier count includes every affected station exactly once.
import {sortByPriority,priorityReasons,priorityKey,effectiveTier,deadline,DEFAULT_DEADLINES,tierRank} from './priority.mjs';
const OPEN=s=>s!=='resolved'&&s!=='merged';
const minutesSince=(iso,now)=>{const t=Date.parse(iso||'');return Number.isFinite(t)?Math.max(0,Math.round((now-t)/60000)):null;};
export function nextAction(item){
 if(item.scope==='feed')return 'Check the data-service status. Station outage confirmation is held until a complete snapshot arrives.';
 if(item.telemetry==='recovering')return 'Monitor recovery. Telemetry must hold before the incident resolves.';
 if(item.telemetry==='partial-recovery')return 'Some members recovered. Review the remaining stations.';
 if(item.plannedIn)return `Planned: ${item.plannedIn.title} (${item.plannedIn.date}).`;
 if(item.deferral)return `Deferred until ${item.deferral.until.slice(0,10)}: ${item.deferral.reason}`;
 if(item.scope==='review')return 'Review QC flags against references before creating work.';
 if(item.scope==='maintenance')return 'Schedule the maintenance visit.';
 if(item.confidence!=='confirmed')return 'Watch for confirmation in the next snapshots.';
 if(!item.assignee)return item.scope==='group'?'Assign an owner, then do the remote investigation before dispatch.':'Assign an owner.';
 if(!item.workCount)return item.scope==='group'?'Create a remote-investigation work item.':item.kind==='outage'?'Create a communications/power work item.':'Create a sensor-inspection work item.';
 return 'Plan a field visit.';
}
export function buildQueue({incidents=[],health={},work=[],plans=[],notes={},coverageGaps={},now=Date.now(),deadlines=DEFAULT_DEADLINES}){
 const open=incidents.filter(i=>OPEN(i.state)),workBy=new Map(),planned=new Map();
 for(const w of work)if(!['done','cancelled'].includes(w.status))for(const key of [w.incidentId,w.station].filter(Boolean))(workBy.get(key)||workBy.set(key,[]).get(key)).push(w);
 for(const p of plans)if(p.status==='accepted')for(const s of p.stations||[])if(!planned.has(s))planned.set(s,{id:p.id,title:p.title,date:p.date});
 const stationIncident=new Map(open.filter(i=>i.scope==='station').map(i=>[i.station,i]));
 const decorate=i=>{
  const stations=i.scope==='group'?i.body?.stations||[]:i.station?[i.station]:[];
  const items=workBy.get(i.id)||[],ready=items.some(w=>w.status==='confirmed'&&!(w.prerequisites||[]).length);
  const importance=Math.max(0,...stations.map(s=>Number(notes[s]?.importance)||0));
  const item={id:i.id,scope:i.scope,kind:i.kind,tier:i.tier,tierOverride:i.tierOverride||null,effectiveTier:effectiveTier(i),confidence:i.confidence,telemetry:i.telemetry,state:i.state,title:i.body?.title||i.station||'Incident',station:i.station||null,stations,groupId:i.groupId||null,
   reasons:i.body?.reasons||[],reasonCodes:i.body?.reasonCodes||[],channels:i.body?.channels||[],sensorGroups:i.body?.sensorGroups||[],provisionalGrouping:!!i.body?.provisionalGrouping,lastGood:i.lastGood,firstSuspected:i.firstSuspected,firstConfirmed:i.firstConfirmed,created:i.created,onset:i.body?.onset||null,feedHeld:!!i.body?.feedHeld,
   durationMinutes:minutesSince(i.lastGood||i.firstSuspected,now),assignee:i.assignee,acknowledged:!!i.acknowledgedAt,deferral:i.deferral,revision:i.revision,workCount:items.length,ready,importance,stationCount:Math.max(1,stations.length),sensorGroupCount:(i.body?.sensorGroups||[]).length,referenceGap:Math.max(0,...stations.map(s=>coverageGaps[s]||0)),
   plannedIn:stations.map(s=>planned.get(s)).find(Boolean)||null,regions:[...new Set(stations.map(s=>notes[s]?.region).filter(Boolean))]};
  item.deadline=deadline(i,deadlines);item.overdue=!!item.deadline&&now>item.deadline&&item.confidence==='confirmed';
  item.priorityReasons=priorityReasons(item,{now});item.priorityKey=priorityKey(item,{now});item.nextAction=nextAction(item);
  return item;
 };
 const groups=open.filter(i=>i.scope==='group'&&(i.body?.stations||[]).length>=2&&i.telemetry==='down');
 const grouped=new Set(groups.flatMap(g=>g.body.stations));
 const top=[...groups,...open.filter(i=>i.scope==='group'&&!groups.includes(i)),...open.filter(i=>i.scope==='station'&&!(i.groupId&&grouped.has(i.station)))].map(decorate);
 for(const g of top.filter(t=>t.scope==='group'))g.members=(g.stations||[]).map(s=>stationIncident.get(s)).filter(Boolean).map(decorate);
 // QC suspicion without another open incident is a review item (tier QC), never a missing-sensor fault.
 for(const [sid,h] of Object.entries(health))if(h.qcSuspect?.length&&!stationIncident.has(sid)&&h.reporting!=='inactive')top.push(decorate({id:'qc:'+sid,scope:'review',kind:'qc',tier:'QC',state:'new',confidence:'suspected',telemetry:'reporting',station:sid,created:h.assessedAt,body:{title:h.name||sid,reasons:[`QC flags on ${h.qcSuspect.join(', ')}; review against references.`],reasonCodes:['qc-suspect'],stations:[sid]}}));
 for(const w of work)if(!w.incidentId&&w.template==='scheduled-service'&&!['done','cancelled'].includes(w.status))top.push(decorate({id:'pm:'+w.id,scope:'maintenance',kind:'scheduled-service',tier:'PM',state:w.status,confidence:'confirmed',telemetry:'reporting',station:w.station,created:w.created,body:{title:w.title,reasons:[w.reason||'Scheduled maintenance'],stations:[w.station]}}));
 const feed=top.filter(t=>t.scope==='feed'),dispatch=sortByPriority(top.filter(t=>t.scope!=='feed'),{now});
 const count=t=>dispatch.filter(x=>x.effectiveTier===t);
 const counts={P1:count('P1').length,P1Stations:count('P1').reduce((s,g)=>s+(g.scope==='group'?g.stations.length:1),0),P2:count('P2').length,P3:count('P3').length,P4:count('P4').length,QC:count('QC').length,PM:count('PM').length,suspected:dispatch.filter(x=>x.confidence!=='confirmed'&&tierRank(x.effectiveTier)<=4).length,unassigned:dispatch.filter(x=>!x.assignee&&tierRank(x.effectiveTier)<=4).length,overdue:dispatch.filter(x=>x.overdue).length};
 counts.stationsAffected=new Set(dispatch.filter(x=>tierRank(x.effectiveTier)<=4).flatMap(x=>x.stations)).size;
 return {queue:dispatch,feed,counts,countNote:'P1 counts groups; P1 stations counts their members once. P2 excludes stations already inside an active group. Suspected items are included and labelled.'};
}
