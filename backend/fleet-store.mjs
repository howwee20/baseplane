// D1 persistence for fleet operations. Pure rules live in web/lib/fleet; this file only maps rows.
import {AppError} from './storage.mjs';
const J=v=>v===null||v===undefined?null:JSON.stringify(v);
const P=(v,f=null)=>{if(v===null||v===undefined||v==='')return f;try{return JSON.parse(v);}catch{return f;}};
const MAX_BODY=900_000;
const sized=(v,what)=>{const s=JSON.stringify(v);if(s.length>MAX_BODY)throw new AppError(`${what} is too large to save.`,413);return s;};

// ---------- ingests, profiles and station state ----------
export async function latestIngest(db){const r=await db.prepare("SELECT * FROM ingests WHERE status='ok' ORDER BY retrieved_at DESC LIMIT 1").first();return r?{...r,activeCount:r.active_count,reasons:P(r.reasons,[])}:null;}
export async function recentIngests(db,limit=12){const {results}=await db.prepare('SELECT id,retrieved_at,status,quality,station_count,active_count,response_count,fresh_count,network_newest,reasons,assessed_at FROM ingests ORDER BY retrieved_at DESC LIMIT ?').bind(limit).all();return results.map(r=>({...r,reasons:P(r.reasons,[])}));}
// Profiles and hysteresis state are single bounded JSON rows: one read and at most one write per assessment.
const BLOB_MAX=1_800_000;// below the 2 MB D1 row limit
export async function readBlob(db,key){const r=await db.prepare('SELECT body,revision,updated,updated_by FROM fleet_blobs WHERE key=?').bind(key).first();return r?{body:P(r.body,{}),revision:r.revision,updated:r.updated,updatedBy:r.updated_by}:{body:{},revision:null};}
export function blobStatement(db,key,body,expected,actor='system'){
 const text=JSON.stringify(body);if(text.length>BLOB_MAX)throw new AppError(`Fleet ${key} data exceeds ${BLOB_MAX} bytes; split storage before adding more stations.`,507);
 const rev=crypto.randomUUID(),now=new Date().toISOString();
 return expected?db.prepare('UPDATE fleet_blobs SET body=?,revision=?,updated=?,updated_by=? WHERE key=? AND revision=?').bind(text,rev,now,actor,key,expected)
  :db.prepare('INSERT INTO fleet_blobs(key,body,revision,updated,updated_by) VALUES(?,?,?,?,?)').bind(key,text,rev,now,actor);
}
// Fails the surrounding batch if the blob changed since it was read (or appeared when it was absent).
export const blobGuard=(db,key,expected)=>expected?db.prepare('INSERT INTO write_guard(x) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM fleet_blobs WHERE key=? AND revision=?)').bind(key,expected):db.prepare('INSERT INTO write_guard(x) SELECT 1 WHERE EXISTS(SELECT 1 FROM fleet_blobs WHERE key=?)').bind(key);
export async function loadProfiles(db){const b=await readBlob(db,'profiles');return {stations:b.body.stations||{},revision:b.revision};}
export async function stationProfile(db,station){return ((await loadProfiles(db)).stations[station]||[]).map(r=>({...r,station}));}
export async function updateProfileRow(db,station,channel,revision,patch,actor){
 for(let attempt=0;attempt<3;attempt++){
  const {stations,revision:blobRev}=await loadProfiles(db),rows=stations[station]||[],row=rows.find(r=>r.channel===channel);
  if(!row)throw new AppError('Sensor channel not found in the profile.',404);
  if(!revision||revision!==row.revision)throw new AppError('This sensor profile changed. Reload before saving.',409);
  const now=new Date().toISOString(),next={...row,...patch,source:'team',groupSource:patch.sensorGroup?'team':row.groupSource,revision:crypto.randomUUID(),updated:now,updatedBy:actor};
  const body={stations:{...stations,[station]:rows.map(r=>r.channel===channel?next:r)}};
  try{const [,res]=await db.batch([blobGuard(db,'profiles',blobRev),blobStatement(db,'profiles',body,blobRev,actor)]);if(res.meta.changes===1)return {...next,station};}
  catch(e){if(!String(e).includes('CHECK constraint'))throw e;}
 }
 throw new AppError('Sensor profiles are busy. Retry in a moment.',409);
}
export async function loadStationStates(db){const b=await readBlob(db,'station_state');return {states:b.body.states||{},revision:b.revision};}

// ---------- incidents ----------
const COLS=['id','scope','kind','station','group_id','tier','tier_override','state','confidence','telemetry','assignee','acknowledged_by','acknowledged_at','first_suspected','first_confirmed','last_good','last_assessed','recovered_at','resolved_at','resolution','deferral','body','revision','created','updated','algorithm'];
export function incidentFromRow(r){if(!r)return null;return {id:r.id,scope:r.scope,kind:r.kind,station:r.station,groupId:r.group_id,tier:r.tier,tierOverride:P(r.tier_override),state:r.state,confidence:r.confidence,telemetry:r.telemetry,assignee:r.assignee,acknowledgedBy:r.acknowledged_by,acknowledgedAt:r.acknowledged_at,firstSuspected:r.first_suspected,firstConfirmed:r.first_confirmed,lastGood:r.last_good,lastAssessed:r.last_assessed,recoveredAt:r.recovered_at,resolvedAt:r.resolved_at,resolution:r.resolution,deferral:P(r.deferral),body:P(r.body,{}),revision:r.revision,created:r.created,updated:r.updated,algorithm:r.algorithm};}
const rowValues=i=>[i.id,i.scope,i.kind,i.station??null,i.groupId??null,i.tier,J(i.tierOverride),i.state,i.confidence,i.telemetry,i.assignee??null,i.acknowledgedBy??null,i.acknowledgedAt??null,i.firstSuspected??null,i.firstConfirmed??null,i.lastGood??null,i.lastAssessed??null,i.recoveredAt??null,i.resolvedAt??null,i.resolution??null,J(i.deferral),sized(i.body,'Incident'),i.revision,i.created,i.updated,i.algorithm];
export async function loadEngineIncidents(db,reopenWindowHours=24){
 const since=new Date(Date.now()-reopenWindowHours*36e5).toISOString();
 const {results}=await db.prepare("SELECT * FROM incidents WHERE state NOT IN ('resolved','merged') OR (state='resolved' AND resolved_at>=?)").bind(since).all();
 return results.map(incidentFromRow);
}
export async function openIncidents(db){const {results}=await db.prepare("SELECT * FROM incidents WHERE state NOT IN ('resolved','merged') ORDER BY created LIMIT 2000").all();return results.map(incidentFromRow);}
export async function getIncident(db,id){return incidentFromRow(await db.prepare('SELECT * FROM incidents WHERE id=?').bind(id).first());}
export async function listIncidents(db,{state='open',station=null,cursor='',limit=50}={}){
 const where=[],binds=[];
 if(state==='open')where.push("state NOT IN ('resolved','merged')");else if(state==='resolved')where.push("state IN ('resolved','merged')");
 if(station){where.push('station=?');binds.push(station);}
 if(cursor){where.push('(updated<? OR (updated=? AND id<?))');const [u,id]=cursor.split('|');binds.push(u,u,id);}
 const {results}=await db.prepare(`SELECT * FROM incidents ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY updated DESC,id DESC LIMIT ?`).bind(...binds,limit+1).all();
 const page=results.slice(0,limit).map(incidentFromRow);
 return {incidents:page,nextCursor:results.length>limit?`${page.at(-1).updated}|${page.at(-1).id}`:null};
}
export async function incidentEvents(db,id,limit=200){const {results}=await db.prepare('SELECT id,at,actor,type,detail,ingest_id FROM incident_events WHERE incident_id=? ORDER BY at DESC,id DESC LIMIT ?').bind(id,limit).all();return results;}
export const eventStatement=(db,e)=>db.prepare('INSERT OR IGNORE INTO incident_events(id,incident_id,at,actor,type,detail,ingest_id) VALUES(?,?,?,?,?,?,?)').bind(e.id||crypto.randomUUID(),e.incidentId,e.at||new Date().toISOString(),String(e.actor).slice(0,100),e.type,String(e.detail).slice(0,2000),e.ingestId||null);
// Multi-row inserts keep audit writes within D1's per-invocation statement budget (100 bound parameters each).
function multiRow(db,head,rows,width,tail=''){const out=[],per=Math.floor(100/width);for(let i=0;i<rows.length;i+=per){const chunk=rows.slice(i,i+per);out.push(db.prepare(`${head} VALUES ${chunk.map(()=>'('+Array(width).fill('?').join(',')+')').join(',')} ${tail}`).bind(...chunk.flat()));}return out;}
export const eventsStatements=(db,events)=>multiRow(db,'INSERT OR IGNORE INTO incident_events(id,incident_id,at,actor,type,detail,ingest_id)',events.map(e=>[e.id||crypto.randomUUID(),e.incidentId,e.at||new Date().toISOString(),String(e.actor).slice(0,100),e.type,String(e.detail).slice(0,2000),e.ingestId||null]),7);
const ENGINE_COLS=['kind','group_id','tier','state','confidence','telemetry','first_suspected','first_confirmed','last_good','last_assessed','recovered_at','resolved_at','resolution','acknowledged_by','acknowledged_at','body','revision','updated'];
// Engine results are written in one transaction. A single guard rolls the batch back if a teammate edited any loaded
// incident (or a profile) after the engine read it; the caller reloads and reruns. Upserts change engine-owned columns
// only: assignee, tier override and deferral belong to people.
export async function saveEngineResult(db,{ingest,result,loadedRevisions,profiles=null,stationStates=null,engine}){
 const statements=[],guarded=result.incidents.filter(i=>!i._new&&loadedRevisions.has(i.id));
 for(let i=0;i<guarded.length;i+=45){const chunk=guarded.slice(i,i+45);statements.push(db.prepare(`INSERT INTO write_guard(x) SELECT 1 WHERE (SELECT count(*) FROM incidents WHERE ${chunk.map(()=>'(id=? AND revision=?)').join(' OR ')})<>?`).bind(...chunk.flatMap(c=>[c.id,loadedRevisions.get(c.id)]),chunk.length));}
 const rows=result.incidents.map(inc=>{const {_new,_changed,_bump,...clean}=inc;if(_new||_bump||!clean.revision)clean.revision=crypto.randomUUID();return rowValues(clean);});
 statements.push(...multiRow(db,`INSERT INTO incidents(${COLS.join(',')})`,rows,COLS.length,`ON CONFLICT(id) DO UPDATE SET ${ENGINE_COLS.map(c=>`${c}=excluded.${c}`).join(',')}`));
 statements.push(...eventsStatements(db,result.events));
 statements.push(...multiRow(db,'INSERT OR IGNORE INTO alerts(id,dedupe,incident_id,kind,tier,title,detail,created,suppressed)',result.alerts.map(a=>[a.id,a.dedupe,a.incidentId,a.kind,a.tier,String(a.title).slice(0,300),String(a.detail).slice(0,2000),a.created,a.suppressed?1:0]),9));
 if(stationStates)statements.push(blobGuard(db,'station_state',stationStates.revision),blobStatement(db,'station_state',{states:stationStates.states},stationStates.revision));
 if(profiles){statements.push(blobGuard(db,'profiles',profiles.revision),blobStatement(db,'profiles',{stations:profiles.stations},profiles.revision));}
 statements.push(db.prepare('INSERT INTO ingests(id,retrieved_at,status,quality,station_count,active_count,response_count,fresh_count,network_newest,reasons,assessed_at,engine) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET assessed_at=excluded.assessed_at,quality=excluded.quality,reasons=excluded.reasons').bind(ingest.id,ingest.retrievedAt,ingest.status,ingest.quality,ingest.stationCount??null,ingest.activeCount??null,ingest.responseCount??null,ingest.freshCount??null,ingest.networkNewest??null,J(ingest.reasons||[]),new Date().toISOString(),engine));
 try{await db.batch(statements);}catch(e){if(String(e).includes('CHECK constraint'))throw new AppError('Incident or profile edited during assessment.',409);throw e;}
 return statements.length;
}
const HUMAN_STATES=['new','acknowledged','investigating','planned','in_progress','awaiting_parts','awaiting_access','monitoring','resolved'];
// Applies a teammate's edit with a revision check. The server reads the current body so engine evidence is not lost.
export async function patchIncident(db,id,{revision,state,assignee,acknowledge,tierOverride,deferral,note,resolutionReason},actor){
 const inc=await getIncident(db,id);if(!inc)throw new AppError('Incident not found.',404);
 if(!revision||revision!==inc.revision)throw new AppError('This incident changed (new evidence or another teammate). Reload; your entries are still in the form.',409);
 const events=[],now=new Date().toISOString(),ev=(type,detail)=>events.push({incidentId:id,at:now,actor,type,detail});
 if(inc.scope==='feed'&&(state||tierOverride))throw new AppError('Feed incidents resolve automatically when a complete snapshot arrives.');
 if(acknowledge===true&&!inc.acknowledgedAt){inc.acknowledgedBy=actor;inc.acknowledgedAt=now;if(inc.state==='new')inc.state='acknowledged';ev('acknowledged','Acknowledged (not resolved).');}
 if(assignee!==undefined){const a=assignee===null?null:String(assignee).trim().slice(0,100)||null;if(a!==inc.assignee){ev('assigned',a?`Assigned to ${a}.`:'Unassigned.');inc.assignee=a;}}
 if(state!==undefined&&state!==inc.state){
  if(!HUMAN_STATES.includes(state))throw new AppError('Choose a supported incident state.');
  if(state==='resolved'){const reason=String(resolutionReason||'').trim();if(reason.length<3)throw new AppError('Record why this is resolved. Telemetry recovery resolves incidents automatically.');inc.resolution='manual: '+reason.slice(0,300);inc.resolvedAt=now;ev('resolved-manually',`Marked resolved: ${reason.slice(0,300)}. Reopens automatically if the issue is still observed.`);}
  else if(inc.state==='resolved'){inc.resolution=null;inc.resolvedAt=null;ev('reopened-manually','Reopened.');}
  else ev('state',`${inc.state} → ${state}.`);
  inc.state=state;
 }
 if(tierOverride!==undefined){
  if(tierOverride===null){if(inc.tierOverride){ev('tier-override-removed',`Tier override removed; computed tier ${inc.tier}.`);inc.tierOverride=null;}}
  else{const t=tierOverride.tier,reason=String(tierOverride.reason||'').trim();if(!['P1','P2','P3','P4','QC','PM'].includes(t)||reason.length<3)throw new AppError('A tier override needs a tier and a recorded reason.');inc.tierOverride={tier:t,reason:reason.slice(0,500),by:actor,at:now};ev('tier-override',`Urgency set to ${t} (computed ${inc.tier}): ${reason.slice(0,500)}`);}
 }
 if(deferral!==undefined){
  if(deferral===null){if(inc.deferral){ev('deferral-removed','Deferral removed.');inc.deferral=null;}}
  else{const until=Date.parse(deferral.until),reason=String(deferral.reason||'').trim();if(!Number.isFinite(until)||reason.length<3)throw new AppError('A deferral needs a date and a recorded reason.');inc.deferral={until:new Date(until).toISOString(),reason:reason.slice(0,500),by:actor,at:now};ev('deferred',`Deferred until ${inc.deferral.until.slice(0,10)}: ${inc.deferral.reason}`);}
 }
 if(note!==undefined){const n=String(note).trim();if(n)ev('note',n.slice(0,2000));}
 if(!events.length)throw new AppError('No changes to save.');
 const next=crypto.randomUUID();
 const r=await db.batch([db.prepare('UPDATE incidents SET state=?,assignee=?,acknowledged_by=?,acknowledged_at=?,tier_override=?,deferral=?,resolution=?,resolved_at=?,revision=?,updated=? WHERE id=? AND revision=?').bind(inc.state,inc.assignee,inc.acknowledgedBy,inc.acknowledgedAt,J(inc.tierOverride),J(inc.deferral),inc.resolution,inc.resolvedAt,next,now,id,revision),...events.map(e=>eventStatement(db,e))]);
 if(r[0].meta.changes!==1)throw new AppError('This incident changed. Reload before saving.',409);
 return {...inc,revision:next,updated:now};
}
// Group membership overrides (merge/split) are audited and respected by later engine runs.
export async function regroupIncidents(db,{action,id,revision,otherId,otherRevision,stations=[],mode='standalone',reason},actor){
 const r=String(reason||'').trim();if(r.length<3)throw new AppError('Record a reason for the grouping change.');
 const g=await getIncident(db,id);if(!g||g.scope!=='group')throw new AppError('Choose an open group incident.',404);
 if(!revision||revision!==g.revision)throw new AppError('This group changed. Reload before regrouping.',409);
 const now=new Date().toISOString(),statements=[],guards=[],events=[],ev=(incId,type,detail)=>events.push({incidentId:incId,at:now,actor,type,detail});
 const save=(inc,expected)=>{guards.push(db.prepare('INSERT INTO write_guard(x) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM incidents WHERE id=? AND revision=?)').bind(inc.id,expected));inc.revision=crypto.randomUUID();inc.updated=now;statements.push(db.prepare('UPDATE incidents SET state=?,body=?,revision=?,updated=?,resolution=?,resolved_at=? WHERE id=? AND revision=?').bind(inc.state,sized(inc.body,'Incident'),inc.revision,now,inc.resolution??null,inc.resolvedAt??null,inc.id,expected));};
 if(action==='merge'){
  const o=await getIncident(db,otherId);if(!o||o.scope!=='group'||o.id===g.id||!['new','acknowledged','investigating','planned','in_progress','awaiting_parts','awaiting_access','monitoring'].includes(o.state))throw new AppError('Choose another open group to merge.');
  if(!otherRevision||otherRevision!==o.revision)throw new AppError('The other group changed. Reload before merging.',409);
  const moved=o.body.members.filter(m=>m.status==='out').map(m=>m.id);
  g.body.overrides.pinned=[...new Set([...g.body.overrides.pinned,...moved])];g.body.overrides.excluded=g.body.overrides.excluded.filter(x=>!moved.includes(x));
  for(const id2 of moved)if(!g.body.members.some(m=>m.id===id2))g.body.members.push({id:id2,status:'out',joinedAt:now,leftAt:null});
  o.state='merged';o.resolution='merged into '+g.id;o.resolvedAt=now;o.body.mergedInto=g.id;
  ev(g.id,'merged',`Merged ${o.id} (${moved.join(', ')}): ${r}`);ev(o.id,'merged-into',`Merged into ${g.id}: ${r}`);
  save(g,revision);save(o,otherRevision);
 }else if(action==='split'){
  const ids=[...new Set(stations)].filter(s=>g.body.members.some(m=>m.id===s&&m.status==='out'));
  if(!ids.length)throw new AppError('Choose current members to split out.');
  g.body.overrides.excluded=[...new Set([...g.body.overrides.excluded,...ids])];g.body.overrides.pinned=g.body.overrides.pinned.filter(x=>!ids.includes(x));
  for(const m of g.body.members)if(ids.includes(m.id)){m.status='separated';m.leftAt=now;}
  ev(g.id,'split',`Split ${ids.join(', ')} ${mode==='new-group'?'into a new group':'as single-station incidents'}: ${r}`);
  save(g,revision);
  if(mode==='new-group'){
   if(ids.length<2)throw new AppError('A new group needs at least two stations.');
   const nid=crypto.randomUUID(),body={title:`Group outage · ${ids.length} stations`,stations:ids,members:ids.map(x=>({id:x,status:'out',joinedAt:now,leftAt:null})),channels:[],sensorGroups:[],provisionalGrouping:false,reasonCodes:['group-outage','manual-split'],reasons:[`Created by ${actor}: ${r}`],evidence:null,overrides:{pinned:ids,excluded:[],locked:true},optOutGrouping:false,recurrence:0,mergedInto:null,formerGroupId:g.id};
   statements.push(db.prepare(`INSERT INTO incidents(${COLS.join(',')}) VALUES(${COLS.map(()=>'?').join(',')})`).bind(...rowValues({id:nid,scope:'group',kind:'group-outage',station:null,groupId:null,tier:'P1',tierOverride:null,state:'new',confidence:g.confidence,telemetry:'down',body,revision:crypto.randomUUID(),created:now,updated:now,algorithm:g.algorithm,firstSuspected:now,lastAssessed:now,lastGood:g.lastGood})));
   ev(nid,'created',`Split from ${g.id}: ${r}`);
  }else for(const s of ids){const inc=(await db.prepare("SELECT * FROM incidents WHERE scope='station' AND station=? AND state NOT IN ('resolved','merged')").bind(s).first());if(inc){const i=incidentFromRow(inc);i.body.optOutGrouping=true;save(i,i.revision);ev(i.id,'opted-out-of-grouping',`Removed from automatic grouping: ${r}`);}}
 }else throw new AppError('Choose merge or split.');
 for(const e of events)statements.push(eventStatement(db,e));
 try{await db.batch([...guards,...statements]);}catch(e){if(String(e).includes('CHECK constraint'))throw new AppError('A group or member incident changed during regrouping. Reload and retry.',409);throw e;}
 return {ok:true};
}

// ---------- alerts ----------
export async function listAlerts(db,{open=true,cursor='',limit=50}={}){
 const {results}=await db.prepare(`SELECT * FROM alerts WHERE suppressed=0 ${open?'AND acknowledged_at IS NULL':''} ${cursor?'AND created<?':''} ORDER BY created DESC LIMIT ?`).bind(...(cursor?[cursor]:[]),limit+1).all();
 const page=results.slice(0,limit).map(r=>({id:r.id,dedupe:r.dedupe,incidentId:r.incident_id,kind:r.kind,tier:r.tier,title:r.title,detail:r.detail,created:r.created,acknowledgedBy:r.acknowledged_by,acknowledgedAt:r.acknowledged_at}));return {alerts:page,nextCursor:results.length>limit?page.at(-1).created:null};
}
export async function countOpenAlerts(db){return (await db.prepare('SELECT count(*) n FROM alerts WHERE suppressed=0 AND acknowledged_at IS NULL').first())?.n||0;}
export async function acknowledgeAlerts(db,ids,actor){
 if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(i=>typeof i!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(i)))throw new AppError('Choose up to 200 alerts.');
 const now=new Date().toISOString();await db.batch(ids.map(id=>db.prepare('UPDATE alerts SET acknowledged_by=?,acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL').bind(actor,now,id)));return {ok:true,acknowledgedAt:now};
}

// ---------- generic revisioned rows (work items, plans, station notes) ----------
export async function getStationNotes(db,station){const r=await db.prepare('SELECT body,revision,updated,updated_by FROM station_notes WHERE station=?').bind(station).first();return r?{...P(r.body,{}),station,revision:r.revision,updated:r.updated,updatedBy:r.updated_by}:{station,revision:null};}
export async function allStationNotes(db){const {results}=await db.prepare('SELECT station,body FROM station_notes').all();return Object.fromEntries(results.map(r=>[r.station,P(r.body,{})]));}
export async function putStationNotes(db,station,body,revision,actor){
 const now=new Date().toISOString(),next=crypto.randomUUID();
 const r=revision?await db.prepare('UPDATE station_notes SET body=?,revision=?,updated=?,updated_by=? WHERE station=? AND revision=?').bind(sized(body,'Station notes'),next,now,actor,station,revision).run():await db.prepare('INSERT INTO station_notes(station,body,revision,updated,updated_by) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM station_notes WHERE station=?)').bind(station,sized(body,'Station notes'),next,now,actor,station).run();
 if(r.meta.changes!==1)throw new AppError('Station notes changed. Reload before saving.',409);
 return {...body,station,revision:next,updated:now,updatedBy:actor};
}
export function workFromRow(r){return r?{...P(r.body,{}),id:r.id,incidentId:r.incident_id,station:r.station,status:r.status,template:r.template,assignee:r.assignee,revision:r.revision,created:r.created,updated:r.updated}:null;}
export async function getWork(db,id){return workFromRow(await db.prepare('SELECT * FROM work_items WHERE id=?').bind(id).first());}
export async function listWork(db,{station,incident,status,open=false,limit=200}={}){
 const where=[],b=[];if(station){where.push('station=?');b.push(station);}if(incident){where.push('incident_id=?');b.push(incident);}if(status){where.push('status=?');b.push(status);}if(open)where.push("status NOT IN ('done','cancelled')");
 const {results}=await db.prepare(`SELECT * FROM work_items ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY updated DESC LIMIT ?`).bind(...b,limit).all();return results.map(workFromRow);
}
const workBody=w=>{const {id,incidentId,station,status,template,assignee,revision,created,updated,...rest}=w;return rest;};
export async function insertWork(db,w,actor){const now=new Date().toISOString(),rev=crypto.randomUUID();await db.batch([db.prepare('INSERT INTO work_items(id,incident_id,station,status,template,assignee,body,revision,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(w.id,w.incidentId||null,w.station,w.status,w.template||null,w.assignee||null,sized(workBody(w),'Work item'),rev,now,now),...(w.incidentId?[eventStatement(db,{incidentId:w.incidentId,at:now,actor,type:'work-created',detail:`Work item ${w.title} (${w.status}).`})]:[])]);return {...w,revision:rev,created:now,updated:now};}
export async function updateWork(db,w,expected,actor,eventDetail){const now=new Date().toISOString(),rev=crypto.randomUUID();const r=await db.batch([db.prepare('UPDATE work_items SET status=?,assignee=?,body=?,revision=?,updated=? WHERE id=? AND revision=?').bind(w.status,w.assignee||null,sized(workBody(w),'Work item'),rev,now,w.id,expected),...(w.incidentId&&eventDetail?[eventStatement(db,{incidentId:w.incidentId,at:now,actor,type:'work-updated',detail:eventDetail})]:[])]);if(r[0].meta.changes!==1)throw new AppError('This work item changed. Reload before saving.',409);return {...w,revision:rev,updated:now};}
export function planFromRow(r){return r?{...P(r.body,{}),id:r.id,status:r.status,date:r.plan_date,crew:r.crew,title:r.title,revision:r.revision,created:r.created,updated:r.updated,createdBy:r.created_by}:null;}
export async function getPlan(db,id){return planFromRow(await db.prepare('SELECT * FROM plans WHERE id=?').bind(id).first());}
export async function listPlans(db,{from,to,status,limit=100}={}){const where=[],b=[];if(from){where.push('plan_date>=?');b.push(from);}if(to){where.push('plan_date<=?');b.push(to);}if(status){where.push('status=?');b.push(status);}const {results}=await db.prepare(`SELECT id,status,plan_date,crew,title,revision,created,updated,created_by,json_extract(body,'$.summary') AS summary,json_extract(body,'$.outdated') AS outdated FROM plans ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY plan_date DESC,updated DESC LIMIT ?`).bind(...b,limit).all();return results.map(r=>({id:r.id,status:r.status,date:r.plan_date,crew:r.crew,title:r.title,revision:r.revision,created:r.created,updated:r.updated,createdBy:r.created_by,summary:P(r.summary),outdated:P(r.outdated)}));}
const planBody=p=>{const {id,status,date,crew,title,revision,created,updated,createdBy,...rest}=p;return rest;};
export async function savePlan(db,p,expected,actor,summary){
 const now=new Date().toISOString(),rev=crypto.randomUUID(),body=sized(planBody(p),'Plan');
 const st=expected?db.prepare('UPDATE plans SET status=?,plan_date=?,crew=?,title=?,body=?,revision=?,updated=? WHERE id=? AND revision=?').bind(p.status,p.date,p.crew||null,p.title,body,rev,now,p.id,expected):db.prepare('INSERT INTO plans(id,status,plan_date,crew,title,body,revision,created,updated,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(p.id,p.status,p.date,p.crew||null,p.title,body,rev,now,now,actor);
 const r=await db.batch([st,db.prepare('INSERT INTO plan_revisions(plan_id,revision,at,actor,status,summary) VALUES(?,?,?,?,?,?)').bind(p.id,rev,now,actor,p.status,String(summary).slice(0,1000)),db.prepare('DELETE FROM plan_revisions WHERE plan_id=? AND revision NOT IN (SELECT revision FROM plan_revisions WHERE plan_id=? ORDER BY at DESC LIMIT 50)').bind(p.id,p.id)]);
 if(r[0].meta.changes!==1)throw new AppError('This plan changed. Reload it; your edits have not been applied.',409);
 return {...p,revision:rev,updated:now,created:p.created||now,createdBy:p.createdBy||actor};
}
export async function planRevisions(db,id){const {results}=await db.prepare('SELECT revision,at,actor,status,summary FROM plan_revisions WHERE plan_id=? ORDER BY at DESC LIMIT 50').bind(id).all();return results;}

// ---------- reference overrides ----------
export async function referenceOverrides(db,station){const {results}=await db.prepare('SELECT * FROM reference_overrides WHERE station=? ORDER BY at DESC LIMIT 200').bind(station).all();return results;}
export async function addReferenceOverride(db,o,actor){const row={id:crypto.randomUUID(),...o,actor,at:new Date().toISOString()};await db.prepare('INSERT INTO reference_overrides(id,station,variable,reference,action,reason,actor,at) VALUES(?,?,?,?,?,?,?,?)').bind(row.id,row.station,row.variable,row.reference,row.action,row.reason,actor,row.at).run();return row;}
export async function removeReferenceOverride(db,id,reason,actor){const r=await db.prepare('UPDATE reference_overrides SET removed_at=?,removed_by=?,removed_reason=? WHERE id=? AND removed_at IS NULL').bind(new Date().toISOString(),actor,String(reason).slice(0,500),id).run();if(r.meta.changes!==1)throw new AppError('Override not found or already removed.',404);return {ok:true};}

// ---------- retention ----------
export async function pruneFleet(db,now=Date.now()){
 const d=days=>new Date(now-days*864e5).toISOString();
 await db.batch([
  db.prepare('DELETE FROM ingests WHERE retrieved_at<?').bind(d(30)),
  db.prepare('DELETE FROM alerts WHERE acknowledged_at IS NOT NULL AND acknowledged_at<?').bind(d(90)),
  db.prepare('DELETE FROM alerts WHERE suppressed=1 AND created<?').bind(d(30)),
  db.prepare('DELETE FROM provider_cache WHERE expires<?').bind(now-7*864e5)
 ]);
}
