// Forecast-aware field-day planner. Deterministic, bounded heuristic: priority-constrained insertion followed by
// relocate/2-opt improvement. No global optimality is claimed. Selection precedence follows the canonical priority
// tuple; driving order is optimised only when it does not delay urgent (P1/P2) arrivals beyond the tolerance.
import {localToUtc,weekday,validDate,validTime,addDays,localDate,localTime,ZONE} from './time.mjs';
const et=ms=>`${localTime(ms,ZONE)} ET`;
import {compareKeys,tierRank,TIERS} from './priority.mjs';
import {evaluateWindow,alertsFor,validateRules} from './forecast.mjs';
import {leg,matrixIndex} from './routing.mjs';
export const PLANNER_VERSION='planner-v1';
export const PLANNER_DEFAULTS={departLocal:'07:30',returnByLocal:'17:30',maxWorkdayMinutes:600,bufferMinutes:10,urgentDelayToleranceMinutes:30,maxStops:10,unknownServiceMinutes:60,maxIterations:300,breaks:[{label:'Lunch',earliest:'11:30',latest:'13:30',minutes:30}]};
export const EXCLUSION_LABELS={'no-location':'No usable location','skills':'Crew lacks a required skill','duplicate':'Already in another accepted plan','access-day':'No access window on this day','unreachable':'No road route found','no-route-data':'Not in the routing matrix','deferred':'Deferred with a recorded reason','return-deadline':'Would miss the return deadline','workday':'Would exceed the workday length','access-window':'Cannot fit within the access window','weather':'Adopted task-weather rule blocks every feasible time','urgent-delay':'Would delay higher-priority work beyond tolerance','capacity':'Stop limit reached','not-selected':'Not in the manual stop order','no-routing':'Road routing unavailable'};

export function validatePlanInputs(b={}){
 const i={...PLANNER_DEFAULTS,...b};
 if(!validDate(i.date))throw Error('Choose a plan date (YYYY-MM-DD).');
 if(!validTime(i.departLocal)||!validTime(i.returnByLocal)||i.returnByLocal<=i.departLocal)throw Error('Departure and return times must be HH:MM, with return after departure.');
 const place=(p,n)=>{if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||p.lat<40||p.lat>49.5||p.lon<-92||p.lon>-80)throw Error(`Set a ${n} location in the Michigan service area.`);return {label:String(p.label||n).slice(0,100),lat:+p.lat,lon:+p.lon};};
 const start=place(i.start,'starting'),end=i.end?place(i.end,'return'):start;
 for(const [k,lo,hi] of [['maxWorkdayMinutes',60,960],['bufferMinutes',0,120],['urgentDelayToleranceMinutes',0,240],['maxStops',1,20],['unknownServiceMinutes',5,480]])if(!(Number.isInteger(i[k])&&i[k]>=lo&&i[k]<=hi))throw Error(`${k} must be a whole number from ${lo} to ${hi}.`);
 const breaks=(Array.isArray(i.breaks)?i.breaks:[]).slice(0,3).map(x=>{if(!validTime(x.earliest)||!validTime(x.latest)||x.latest<x.earliest||!(Number.isInteger(x.minutes)&&x.minutes>0&&x.minutes<=120))throw Error('Breaks need HH:MM earliest/latest and 1–120 minutes.');return {label:String(x.label||'Break').slice(0,40),earliest:x.earliest,latest:x.latest,minutes:x.minutes};});
 const ids=v=>Array.isArray(v)?[...new Set(v.filter(x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x)))].slice(0,40):[];
 const crew={label:String(i.crew?.label||'Crew').slice(0,60),size:Number.isInteger(i.crew?.size)&&i.crew.size>=1&&i.crew.size<=6?i.crew.size:1,skills:Array.isArray(i.crew?.skills)?[...new Set(i.crew.skills.filter(s=>typeof s==='string').map(s=>s.trim().toLowerCase().slice(0,40)).filter(Boolean))].slice(0,10):[]};
 const visitMinutes={};for(const [k,v] of Object.entries(i.visitMinutes||{}).slice(0,40))if(/^[A-Za-z0-9_-]{1,100}$/.test(k)&&Number.isInteger(v)&&v>=5&&v<=480)visitMinutes[k]=v;
 return {visitMinutes,date:i.date,days:Number.isInteger(i.days)&&i.days>=1&&i.days<=7?i.days:1,start,end,departLocal:i.departLocal,returnByLocal:i.returnByLocal,maxWorkdayMinutes:i.maxWorkdayMinutes,bufferMinutes:i.bufferMinutes,urgentDelayToleranceMinutes:i.urgentDelayToleranceMinutes,maxStops:i.maxStops,unknownServiceMinutes:i.unknownServiceMinutes,maxIterations:Math.min(1000,Math.max(10,Number(i.maxIterations)||300)),breaks,crew,required:ids(i.required),excludeStations:ids(i.excludeStations),includeDuplicates:ids(i.includeDuplicates),manualOrder:b.manualOrder?ids(b.manualOrder):null,region:typeof i.region==='string'?i.region.slice(0,60):null,tiers:Array.isArray(i.tiers)?i.tiers.filter(t=>TIERS[t]):['P1','P2','P3','P4','QC','PM'],rules:validateRules(i.rules||{})};
}
function windowsFor(c,date){
 if(!c.accessWindows)return null;
 const day=weekday(date);return c.accessWindows.filter(w=>w.days.includes(day)).map(w=>({start:localToUtc(date,w.start).ms,end:localToUtc(date,w.end).ms})).sort((a,b)=>a.start-b.start);
}
// Simulates one ordered route. Returns schedule plus the first hard violation, if any.
function simulate(route,ctx){
 const {inputs,date,matrix,idx,departMs,returnByMs,forecasts,alerts}=ctx,breaks=inputs.breaks.map(b=>({...b,earliestMs:localToUtc(date,b.earliest).ms,latestMs:localToUtc(date,b.latest).ms,taken:null}));
 let t=departMs,prev='start',driveSec=0,distanceM=0,waitMin=0,serviceMin=0,bufferMin=0,breakMin=0,uncertainty=0;const stops=[],warnings=[],violations=[];
 // Relaxed mode (a deliberate stop order) records hard-constraint violations and keeps scheduling; strict mode stops.
 const fail=v=>{if(ctx.relaxed){violations.push(v);return null;}return {ok:false,...v};};
 const etd=ms=>et(ms)+(localDate(ms,ZONE)!==date?' (next day)':'');
 const takeBreaks=(where)=>{for(const b of breaks)if(!b.taken&&t>=b.earliestMs){b.taken={startMs:t,endMs:t+b.minutes*60000,at:where};if(t>b.latestMs)warnings.push(`${b.label} starts after ${inputs.breaks.find(x=>x.label===b.label).latest} (provisional preference).`);t+=b.minutes*60000;breakMin+=b.minutes;}};
 for(const c of route){
  takeBreaks(prev);
  const l=leg(matrix,prev,c.id,idx);if(!l)return {ok:false,code:'unreachable',reason:`No road route from ${prev==='start'?inputs.start.label:prev} to ${c.name}.`,stop:c.id};
  const arrive=t+l.durationSec*1000;driveSec+=l.durationSec;distanceM+=l.distanceM||0;
  const service=(c.serviceMinutes??inputs.unknownServiceMinutes)*60000,ws=windowsFor(c,date);
  let start=arrive;
  if(ws){const w=ws.find(w=>Math.max(arrive,w.start)+service<=w.end);if(!w){const f=fail({code:'access-window',reason:`${c.name} cannot be completed inside its access window (arrival ${etd(arrive)}).`,stop:c.id});if(f)return f;}else start=Math.max(arrive,w.start);}
  // Use a long access-window wait for a pending break when it is already allowed.
  for(const b of breaks)if(!b.taken&&start-arrive>=b.minutes*60000&&arrive>=b.earliestMs){b.taken={startMs:arrive,endMs:arrive+b.minutes*60000,at:c.id};breakMin+=b.minutes;}
  const end=start+service,f=forecasts?.[c.stationId];
  const weather=evaluateWindow(f?.forecast||null,{startMs:start,endMs:end,taskClass:c.taskClass,rules:inputs.rules,lat:c.lat,lon:c.lon,alerts:f?alertsFor(alerts,{zones:f.zones||[],startMs:start,endMs:end}):[],now:ctx.now});
  if(weather.status==='blocked'){const f=fail({code:'weather',reason:`${c.name}: ${weather.reasons.filter(r=>/Adopted/.test(r)).join(' ')}`,stop:c.id});if(f)return f;}
  waitMin+=(start-arrive)/60000;serviceMin+=service/60000;bufferMin+=inputs.bufferMinutes;uncertainty+=c.serviceUncertainty||0;
  stops.push({id:c.id,arriveMs:arrive,serviceStartMs:start,serviceEndMs:end,departMs:end+inputs.bufferMinutes*60000,driveSec:l.durationSec,distanceM:l.distanceM,weather});
  t=end+inputs.bufferMinutes*60000;prev=c.id;
 }
 takeBreaks(prev);
 const back=leg(matrix,prev,'end',idx)||(prev==='start'&&inputs.start.lat===inputs.end.lat&&inputs.start.lon===inputs.end.lon?{durationSec:0,distanceM:0}:null);if(!back)return {ok:false,code:'unreachable',reason:`No road route back to ${inputs.end.label}.`,stop:prev==='start'?null:prev};
 const returnMs=t+back.durationSec*1000;driveSec+=back.durationSec;distanceM+=back.distanceM||0;
 if(returnMs>returnByMs){const f=fail({code:'return-deadline',reason:`Return at ${etd(returnMs)} is ${Math.ceil((returnMs-returnByMs)/60000)} min after the ${et(returnByMs)} deadline.`,stop:route.at(-1)?.id,returnMs});if(f)return f;}
 if(returnMs-departMs>inputs.maxWorkdayMinutes*60000){const f=fail({code:'workday',reason:`Workday would be ${Math.ceil((returnMs-departMs)/60000)} min (limit ${inputs.maxWorkdayMinutes}).`,stop:route.at(-1)?.id});if(f)return f;}
 for(const b of breaks)if(!b.taken&&route.length&&returnMs>b.latestMs)warnings.push(`${b.label} not scheduled before ${b.latest} (provisional preference).`);
 return {ok:violations.length===0,violations,stops,returnMs,returnLeg:{driveSec:back.durationSec,distanceM:back.distanceM},breaks:breaks.filter(b=>b.taken).map(b=>({label:b.label,startMs:b.taken.startMs,endMs:b.taken.endMs,at:b.taken.at})),totals:{driveMin:Math.round(driveSec/60),distanceKm:Math.round(distanceM/100)/10,distanceMi:Math.round(distanceM/160.934)/10,serviceMin:Math.round(serviceMin),waitMin:Math.round(waitMin),bufferMin,breakMin,workdayMin:Math.round((returnMs-departMs)/60000),uncertaintyMin:uncertainty},warnings,weatherCost:stops.reduce((s,x)=>s+(x.weather.status==='caution'?2:x.weather.status==='unknown'?1:0),0),uncertaintyReturnMs:returnMs+uncertainty*60000};
}
const arrivalOf=(sched,id)=>sched.stops.find(s=>s.id===id)?.serviceStartMs;
// Rejects a change that delays any stop of higher priority than `rank` by more than the tolerance.
function delaysUrgent(before,after,route,rank,tol){
 for(const c of route){if(tierRank(c.tier)>=rank)continue;const a=arrivalOf(before,c.id),b=arrivalOf(after,c.id);if(a!==undefined&&b!==undefined&&b-a>tol*60000)return {stop:c,minutes:Math.round((b-a)/60000)};}
 return null;
}
function improve(route,sched,ctx){
 const tol=ctx.inputs.urgentDelayToleranceMinutes,baseline=sched;let best=route,bestSched=sched,iter=0,improved=true;
 const better=(s,cur)=>s.returnMs<cur.returnMs-60000||s.returnMs<=cur.returnMs+60000&&s.weatherCost<cur.weatherCost;
 const urgentOk=s=>route.every(c=>tierRank(c.tier)>2||arrivalOf(s,c.id)<=arrivalOf(baseline,c.id)+tol*60000);
 while(improved&&iter<ctx.inputs.maxIterations){
  improved=false;
  outer:for(let i=0;i<best.length;i++)for(let j=0;j<best.length;j++){
   if(i===j)continue;iter++;if(iter>=ctx.inputs.maxIterations)break outer;
   const moves=[];const r1=[...best];const [x]=r1.splice(i,1);r1.splice(j,0,x);moves.push(r1);
   if(i<j){const r2=[...best.slice(0,i),...best.slice(i,j+1).reverse(),...best.slice(j+1)];moves.push(r2);}
   for(const r of moves){const s=simulate(r,ctx);if(s.ok&&better(s,bestSched)&&urgentOk(s)){best=r;bestSched=s;improved=true;break outer;}}
  }
 }
 return {route:best,sched:bestSched,iterations:iter};
}
// candidates: stops prepared by the server (one per station) with tier, priorityKey and task information.
export function planDay({inputs,date=inputs.date,candidates,matrix,forecasts={},alerts=[],now=Date.now()}){
 const departMs=localToUtc(date,inputs.departLocal).ms,returnByMs=Math.min(localToUtc(date,inputs.returnByLocal).ms,departMs+inputs.maxWorkdayMinutes*60000);
 const excluded=[],exceptions=[],warnings=[],ex=(c,code,reason)=>excluded.push({stationId:c.stationId,name:c.name,tier:c.tier,incidentIds:c.incidentIds||[],code,label:EXCLUSION_LABELS[code]||code,reason});
 if(!matrix)return {version:PLANNER_VERSION,date,feasible:false,stops:[],excluded:candidates.map(c=>({stationId:c.stationId,name:c.name,tier:c.tier,incidentIds:c.incidentIds||[],code:'no-routing',label:EXCLUSION_LABELS['no-routing'],reason:'Road routing is unavailable, so no itinerary can be computed.'})),blockers:['Road routing unavailable.'],exceptions,warnings,addressed:{},score:null,departMs,returnByMs};
 const idx=matrixIndex(matrix),ctx={inputs,date,matrix,idx,departMs,returnByMs,forecasts,alerts,now};
 const ordered=[...candidates].sort((a,b)=>(inputs.required.includes(b.stationId)-inputs.required.includes(a.stationId))||compareKeys(a.priorityKey,b.priorityKey));
 const pool=[];
 for(const c of ordered){
  if(!Number.isFinite(c.lat)||!Number.isFinite(c.lon)){ex(c,'no-location','Station has no valid coordinates.');continue;}
  if(c.deferral&&Date.parse(c.deferral.until)>Date.parse(date+'T23:59:59Z')){ex(c,'deferred',`Deferred until ${c.deferral.until.slice(0,10)}: ${c.deferral.reason}`);continue;}
  const missing=(c.requiredSkills||[]).filter(s=>!inputs.crew.skills.includes(s.toLowerCase()));if(missing.length){ex(c,'skills',`Needs ${missing.join(', ')}; crew skills: ${inputs.crew.skills.join(', ')||'none recorded'}.`);continue;}
  if(c.alreadyPlanned&&!inputs.includeDuplicates.includes(c.stationId)){ex(c,'duplicate',`In accepted plan "${c.alreadyPlanned.title}" (${c.alreadyPlanned.crew||'crew'}, ${c.alreadyPlanned.date}).`);continue;}
  const ws=windowsFor(c,date);if(ws&&!ws.length){ex(c,'access-day','No access window on this weekday.');continue;}
  if(!idx.has(c.id)){ex(c,'no-route-data','Not included in the routing matrix.');continue;}
  if(!leg(matrix,'start',c.id,idx)||!leg(matrix,c.id,'end',idx)){ex(c,'unreachable','No road route between this station and the start/return locations.');continue;}
  pool.push(c);
 }
 let route=[],sched=simulate([],ctx);
 if(!sched.ok)return {version:PLANNER_VERSION,date,feasible:false,stops:[],excluded,blockers:[sched.reason],exceptions,warnings,addressed:{},score:null,departMs,returnByMs};
 if(inputs.manualOrder){
  route=inputs.manualOrder.map(id=>pool.find(c=>c.stationId===id)).filter(Boolean);
  for(const c of pool)if(!route.includes(c))ex(c,'not-selected','Not in the manual stop order.');
  sched=simulate(route,{...ctx,relaxed:true});
  if(!sched.stops){warnings.push('Manual order is infeasible: '+sched.reason);return finalize(route,null,{manual:true,violation:sched});}
  if(sched.violations.length)warnings.push('Manual order is infeasible: '+sched.violations.map(v=>v.reason).join(' '));
  const auto=inputs.skipComparison?{stops:[]}:planDay({inputs:{...inputs,manualOrder:null},date,candidates:route,matrix,forecasts,alerts,now});
  for(const c of route){if(tierRank(c.tier)>2)continue;const a=auto.stops.find(s=>s.stationId===c.stationId)?.serviceStartMs,b=arrivalOf(sched,c.id);if(a&&b&&b-a>inputs.urgentDelayToleranceMinutes*60000)exceptions.push({type:'manual-order-urgent-delay',stationId:c.stationId,detail:`Manual order reaches ${c.tier} ${c.name} ${Math.round((b-a)/60000)} min later than the priority-respecting order. Record a reason if deliberate.`});}
  return finalize(route,sched,{manual:true});
 }
 for(const c of pool){
  if(route.length>=inputs.maxStops){ex(c,'capacity',`Stop limit of ${inputs.maxStops} reached.`);continue;}
  let best=null;const fails=[];
  for(let pos=0;pos<=route.length;pos++){
   const trial=[...route.slice(0,pos),c,...route.slice(pos)],s=simulate(trial,ctx);
   if(!s.ok){fails.push(s);continue;}
   const delay=delaysUrgent(sched,s,route,tierRank(c.tier),inputs.urgentDelayToleranceMinutes);
   if(delay){fails.push({code:'urgent-delay',reason:`Would delay ${delay.stop.tier} ${delay.stop.name} by ${delay.minutes} min (tolerance ${inputs.urgentDelayToleranceMinutes}).`});continue;}
   const cost=[s.returnMs-sched.returnMs,s.weatherCost,pos];
   if(!best||compareKeys(cost,best.cost)<0)best={trial,s,cost};
  }
  if(best){route=best.trial;sched=best.s;}
  else{const order=['weather','access-window','urgent-delay','return-deadline','workday','unreachable'];const f=fails.sort((a,b)=>order.indexOf(a.code)-order.indexOf(b.code))[0]||{code:'return-deadline',reason:'No feasible position.'};ex(c,f.code,f.reason);}
 }
 const imp=improve(route,sched,ctx);route=imp.route;sched=imp.sched;
 return finalize(route,sched,{iterations:imp.iterations});

 function finalize(r,s,meta){
  const byId=new Map(r.map(c=>[c.id,c])),stops=(s?.stops||[]).map((x,i)=>{const c=byId.get(x.id);const w=[];if(!c.entranceKnown)w.push('Final access and walking time unknown; routed to the station coordinates.');const snap=matrix.points[idx.get(c.id)]?.snappedDistanceM;if(Number.isFinite(snap)&&snap>200)w.push(`Nearest routable road is about ${Math.round(snap)} m from the routing point.`);if(c.estimateBasis!=='entered')w.push(c.serviceMinutes==null?`On-site time unknown; ${inputs.unknownServiceMinutes} min assumed.`:'On-site time is a template estimate (unconfirmed).');if(x.weather.status==='unknown')w.push('Weather at this time is unknown.');if(c.alreadyPlanned)w.push(`Also on accepted trip "${c.alreadyPlanned.title}" (${c.alreadyPlanned.crew||'crew'}, ${c.alreadyPlanned.date}).`);
   return {order:i+1,stationId:c.stationId,name:c.name,lat:c.lat,lon:c.lon,tier:c.tier,priorityReasons:c.priorityReasons||[],incidentIds:c.incidentIds||[],groupId:c.groupId||null,workItemIds:c.workItemIds||[],tasks:c.tasks||[],parts:c.parts||[],taskClass:c.taskClass,serviceMinutes:c.serviceMinutes??inputs.unknownServiceMinutes,uncertaintyMinutes:c.serviceUncertainty||0,estimateBasis:c.estimateBasis||'unknown',driveMin:Math.round(x.driveSec/60),distanceKm:Math.round((x.distanceM||0)/100)/10,arriveMs:x.arriveMs,waitMin:Math.round((x.serviceStartMs-x.arriveMs)/60000),serviceStartMs:x.serviceStartMs,serviceEndMs:x.serviceEndMs,departMs:x.departMs,weather:{status:x.weather.status,reasons:x.weather.reasons,values:x.weather.values,taskClass:x.weather.taskClass,adopted:x.weather.adopted,updateTime:x.weather.updateTime,fetchedAt:x.weather.fetchedAt},warnings:w};});
  const addressed={};for(const st of stops)(addressed[st.tier]??=[]).push(st.stationId);
  const all=[...candidates];
  // Feasible urgent work must not be displaced by convenient lower-tier stops; any urgent exclusion is surfaced.
  for(const e of excluded)if(tierRank(e.tier)<=2&&!['duplicate','deferred','not-selected'].includes(e.code))exceptions.push({type:'urgent-not-scheduled',stationId:e.stationId,detail:`${e.tier} ${e.name} not scheduled: ${e.reason}`});
  const unaddressed=t=>all.filter(c=>c.tier===t&&!stops.some(s=>s.stationId===c.stationId)).length;
  const incidents=[...new Set(stops.flatMap(s=>s.incidentIds))];
  if(s&&s.uncertaintyReturnMs>returnByMs&&stops.length)warnings.push(`If every task runs to its upper estimate (+${s.totals.uncertaintyMin} min), return would be ${Math.ceil((s.uncertaintyReturnMs-returnByMs)/60000)} min after the deadline.`);
  if(matrix.traffic==='none')warnings.push('Drive times use typical road speeds without departure-time traffic.');
  if(matrix.synthetic)warnings.push('SYNTHETIC routing fixture — not real driving times.');
  return {version:PLANNER_VERSION,date,feasible:!!s&&s.ok,violations:s?.violations||[],manual:!!meta.manual,departMs,returnByMs,returnMs:s?.returnMs??null,stops,breaks:s?.breaks||[],returnLeg:s?.returnLeg||null,totals:s?.totals||null,excluded,exceptions,warnings:[...warnings,...(s?.warnings||[])],blockers:meta.violation?[meta.violation.reason]:[],addressed,addressedIncidents:incidents,
   weatherSummary:stops.reduce((m,x)=>(m[x.weather.status]=(m[x.weather.status]||0)+1,m),{}),
   score:[unaddressed('P1'),unaddressed('P2'),unaddressed('P3'),unaddressed('P4'),s?.weatherCost??0,s?.totals?.driveMin??0],iterations:meta.iterations||0};
 }
}
// Compares candidate days and explains the recommendation; urgent work is never postponed for nicer weather.
export function compareDays(results,{today}={}){
 const days=results.map(r=>({date:r.date,feasible:r.feasible,stops:r.stops.length,addressed:Object.fromEntries(Object.entries(r.addressed||{}).map(([k,v])=>[k,v.length])),weather:r.weatherSummary||{},driveMin:r.totals?.driveMin??null,returnMs:r.returnMs,score:r.score,forecastCoverage:r.stops.length?r.stops.every(s=>s.weather.status!=='unknown')?'full':r.stops.some(s=>s.weather.status!=='unknown')?'partial':'none':'n/a'}));
 const usable=results.filter(r=>r.feasible&&r.stops.length);
 if(!usable.length){
  const codes={};for(const r of results)for(const e of r.excluded)codes[e.code]=(codes[e.code]||0)+1;
  const decisions={'return-deadline':'Extend the return deadline or workday, or start earlier.','workday':'Extend the workday length.','skills':'Assign a crew with the required skills.','access-window':'Confirm or widen access windows.','access-day':'Confirm access on other weekdays.','weather':'Review adopted task-weather rules or choose another task class.','unreachable':'Check station coordinates or record a road entrance.','no-routing':'Configure road routing (OpenRouteService key).','duplicate':'Coordinate with the crew that already planned these stations.','capacity':'Raise the stop limit.'};
  return {days,recommendation:null,alternatives:[],noFeasible:{blockers:Object.entries(codes).sort((a,b)=>b[1]-a[1]).map(([code,n])=>({code,label:EXCLUSION_LABELS[code]||code,count:n})),decisions:[...new Set(Object.keys(codes).map(k=>decisions[k]).filter(Boolean))]}};
 }
 const urgentKey=r=>[r.score[0],r.score[1]];
 const bestUrgent=usable.map(urgentKey).sort(compareKeys)[0];
 const hasUrgent=results.some(r=>r.stops.some(s=>tierRank(s.tier)<=2)||r.excluded.some(e=>tierRank(e.tier)<=2&&!['duplicate','deferred'].includes(e.code)));
 const rank=r=>hasUrgent?[...urgentKey(r),r.date,r.score[2],r.score[3],r.score[4],r.score[5]]:[r.score[2],r.score[3],r.score[4],r.date,r.score[5]];
 const sorted=[...usable].sort((a,b)=>compareKeys(rank(a),rank(b))),rec=sorted[0];
 const why=[];
 if(hasUrgent){why.push(`Earliest day that reaches the most urgent work (${rec.stops.filter(s=>tierRank(s.tier)<=2).length} P1/P2 stop${rec.stops.filter(s=>tierRank(s.tier)<=2).length===1?'':'s'}).`);}
 else why.push('No P1/P2 work is pending; chosen for coverage, then weather, then date.');
 why.push(`${rec.stops.length} stops, return ${rec.totals.workdayMin} min after departure, ${rec.totals.distanceMi} road miles.`);
 if(rec.weatherSummary.caution)why.push(`${rec.weatherSummary.caution} stop${rec.weatherSummary.caution===1?' has':'s have'} weather cautions (provisional rules).`);
 if(rec.weatherSummary.unknown)why.push(`Weather unknown for ${rec.weatherSummary.unknown} stop${rec.weatherSummary.unknown===1?'':'s'}.`);
 const alternatives=[];
 const weatherBest=[...usable].filter(r=>r!==rec&&compareKeys(urgentKey(r),bestUrgent)===0).sort((a,b)=>a.score[4]-b.score[4]||a.date.localeCompare(b.date))[0];
 if(weatherBest&&weatherBest.score[4]<rec.score[4]){
  const wait=Math.round((Date.parse(weatherBest.date)-Date.parse(rec.date))/864e5),urgent=rec.stops.filter(s=>tierRank(s.tier)<=2);
  alternatives.push({date:weatherBest.date,label:'Better weather',why:`Fewer weather cautions or unknowns (${weatherBest.score[4]} vs ${rec.score[4]}).`,consequence:urgent.length?`Waiting ${wait} day${wait===1?'':'s'} leaves ${urgent.map(s=>`${s.tier} ${s.name}`).join(', ')} unresolved that much longer.`:`Waiting ${wait} day${wait===1?'':'s'}.`});
 }
 const most=[...usable].filter(r=>r!==rec&&r!==weatherBest).sort((a,b)=>b.stops.length-a.stops.length||compareKeys(a.score,b.score))[0];
 if(most&&most.stops.length>rec.stops.length)alternatives.push({date:most.date,label:'Most stops',why:`${most.stops.length} stops vs ${rec.stops.length}.`,consequence:compareKeys(urgentKey(most),urgentKey(rec))>0?'Reaches less urgent work.':''});
 const next=sorted.find(r=>r!==rec&&!alternatives.some(a=>a.date===r.date));
 if(next&&alternatives.length<3)alternatives.push({date:next.date,label:'Next best',why:`${next.stops.length} stops; ${next.weatherSummary.caution||0} weather cautions.`,consequence:''});
 return {days,recommendation:{date:rec.date,why},alternatives:alternatives.slice(0,3),noFeasible:null};
}
export function planDates(inputs,forecastEnd){
 const out=[];for(let i=0;i<inputs.days;i++)out.push(addDays(inputs.date,i));
 return out.map(d=>({date:d,forecastCovered:!!forecastEnd&&localToUtc(d,inputs.returnByLocal).ms<=Date.parse(forecastEnd)}));
}
// Marks an accepted plan outdated when material inputs changed; never rewrites the itinerary.
export function planOutdated(plan,{incidents=[],now=Date.now(),forecastUpdates={}}={}){
 const reasons=[],planned=new Set((plan.result?.stops||[]).map(s=>s.stationId)),snap=plan.snapshot||{},inPlan=new Set((plan.result?.stops||[]).flatMap(s=>s.incidentIds));
 const open=new Map(incidents.filter(i=>i.state!=='resolved'&&i.state!=='merged').map(i=>[i.id,i]));
 for(const id of inPlan)if(!open.has(id))reasons.push({code:'incident-closed',detail:`A planned incident (${snap.incidents?.[id]?.title||id}) is resolved or merged.`});
 for(const i of open.values()){
  const before=snap.incidents?.[i.id];
  if(!before&&tierRank(i.tierOverride?.tier||i.tier)<=2&&i.confidence==='confirmed'&&i.scope!=='feed'&&!(i.body?.stations||[]).every(s=>planned.has(s)))reasons.push({code:'new-urgent',detail:`New ${i.tierOverride?.tier||i.tier} incident: ${i.body?.title||i.id}.`});
  if(before&&tierRank(i.tierOverride?.tier||i.tier)<tierRank(before.tier))reasons.push({code:'escalated',detail:`${i.body?.title||i.id} escalated ${before.tier} → ${i.tierOverride?.tier||i.tier}.`});
 }
 for(const [sid,u] of Object.entries(forecastUpdates)){const was=snap.forecasts?.[sid]?.updateTime;if(was&&u&&Date.parse(u)>Date.parse(was))reasons.push({code:'forecast-updated',detail:`Forecast for ${sid} updated since planning; re-check weather before departure.`});}
 if(plan.status==='accepted'&&plan.date<localDate(now,ZONE))reasons.push({code:'date-passed',detail:'Plan date has passed; record completion or cancel.'});
 return reasons;
}
// A trip without road routing: stops in the chosen order with visit times, and no drive or arrival times.
// Nothing is estimated from straight-line distance.
export function unroutedDay({inputs,date=inputs.date,candidates,reason}){
 const departMs=localToUtc(date,inputs.departLocal).ms,returnByMs=localToUtc(date,inputs.returnByLocal).ms;
 const stops=candidates.map((c,i)=>({order:i+1,stationId:c.stationId,name:c.name,lat:c.lat,lon:c.lon,tier:c.tier,priorityReasons:c.priorityReasons||[],incidentIds:c.incidentIds||[],groupId:c.groupId||null,workItemIds:c.workItemIds||[],tasks:c.tasks||[],parts:c.parts||[],taskClass:c.taskClass,serviceMinutes:c.serviceMinutes??inputs.unknownServiceMinutes,uncertaintyMinutes:c.serviceUncertainty||0,estimateBasis:c.estimateBasis||'unknown',driveMin:null,distanceKm:null,arriveMs:null,waitMin:0,serviceStartMs:null,serviceEndMs:null,departMs:null,weather:{status:'unknown',reasons:['Arrival times not calculated without road routing.'],values:{}},warnings:[]}));
 const addressed={};for(const s of stops)(addressed[s.tier]??=[]).push(s.stationId);
 return {version:PLANNER_VERSION,date,feasible:false,routed:false,violations:[],manual:true,departMs,returnByMs,returnMs:null,stops,breaks:[],returnLeg:null,totals:{driveMin:null,distanceKm:null,distanceMi:null,serviceMin:stops.reduce((t,s)=>t+s.serviceMinutes,0),waitMin:0,bufferMin:0,breakMin:0,workdayMin:null,uncertaintyMin:0},excluded:[],exceptions:[],warnings:[],blockers:[reason||'Road routing unavailable: drive and arrival times were not calculated.'],addressed,addressedIncidents:[...new Set(stops.flatMap(s=>s.incidentIds))],weatherSummary:{},score:null,iterations:0};
}
