// SYNTHETIC routing matrices and forecasts only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planDay,compareDays,validatePlanInputs,planOutdated} from '../../web/lib/fleet/planner.mjs';
import {fixtureMatrix,navigationLinks,normalizeOrsMatrix} from '../../web/lib/fleet/routing.mjs';
import {parseGridpoints,evaluateWindow,validateRules,parseAlerts,alertsFor} from '../../web/lib/fleet/forecast.mjs';
import {localToUtc} from '../../web/lib/fleet/time.mjs';
import {priorityKey} from '../../web/lib/fleet/priority.mjs';

const NOW=Date.parse('2026-10-08T12:00:00Z');
const base={date:'2026-10-09',start:{label:'Base',lat:42.70,lon:-84.50},departLocal:'08:00',returnByLocal:'17:00',maxWorkdayMinutes:600,breaks:[],bufferMinutes:0,urgentDelayToleranceMinutes:30,crew:{label:'Crew A',skills:['electronics']}};
const stop=(id,tier,{lat=43,lon=-84.5,service=60,ageH=10,windows=null,skills=[],taskClass='inspection',extra={}}={})=>{const inc={id:'inc-'+id,tier,confidence:'confirmed',lastGood:new Date(NOW-ageH*36e5).toISOString()};return {id,stationId:id,name:'Synthetic '+id,lat,lon,entranceKnown:false,tier,priorityKey:priorityKey(inc,{now:NOW}),priorityReasons:[],incidentIds:[inc.id],serviceMinutes:service,serviceUncertainty:15,estimateBasis:'entered',taskClass,requiredSkills:skills,accessWindows:windows,tasks:[],parts:[],...extra};};
const points=ids=>[{id:'start',lat:42.7,lon:-84.5},...ids.map((id,i)=>({id,lat:43+i*0.1,lon:-84.5})),{id:'end',lat:42.7,lon:-84.5}];
const sym=(t,a,b,min,km)=>{t[`${a}>${b}`]=[min,km];t[`${b}>${a}`]=[min,km];};

test('feasible urgent work is never displaced by convenient P4 stops; excluded urgent stops carry reasons',()=>{
 const t={};sym(t,'start','P4A',10,10);sym(t,'start','P4B',12,12);sym(t,'P4A','P4B',5,5);sym(t,'start','P2X',150,200);sym(t,'P2X','P4A',150,200);sym(t,'P2X','P4B',150,200);for(const k of Object.keys(t)){const [a,b]=k.split('>');if(a==='start')t[`${b}>end`]=t[k];if(b==='start')t[`end>${a}`]=t[k];}
 const m=fixtureMatrix(points(['P4A','P4B','P2X']),t);
 const r=planDay({inputs:validatePlanInputs(base),candidates:[stop('P4A','P4',{ageH:400}),stop('P4B','P4',{ageH:400}),stop('P2X','P2')],matrix:m,now:NOW});
 assert.ok(r.stops.some(s=>s.stationId==='P2X'),'urgent stop is scheduled first');
 assert.equal(r.excluded.filter(e=>e.tier==='P2').length,0);
 // Tighter day: the P2 alone fits; P4 stops are excluded rather than displacing it.
 const tight=planDay({inputs:validatePlanInputs({...base,returnByLocal:'14:30'}),candidates:[stop('P4A','P4',{ageH:400}),stop('P4B','P4',{ageH:400}),stop('P2X','P2')],matrix:m,now:NOW});
 assert.deepEqual(tight.stops.map(s=>s.stationId),['P2X']);
 assert.ok(tight.excluded.every(e=>e.tier==='P4'&&e.reason));
 // Impossible P2: excluded with an exact reason and surfaced as an exception.
 const imp=planDay({inputs:validatePlanInputs({...base,returnByLocal:'11:00'}),candidates:[stop('P4A','P4'),stop('P2X','P2')],matrix:m,now:NOW});
 assert.ok(imp.excluded.find(e=>e.stationId==='P2X').code==='return-deadline');
 assert.ok(imp.exceptions.some(e=>e.type==='urgent-not-scheduled'&&e.stationId==='P2X'));
});

test('routing respects water barriers, asymmetric and unreachable legs, access windows, service time, breaks and the return deadline',()=>{
 // ACROSS is 40 km away in a straight line but the road trip is long (around the lake): only the matrix is trusted.
 const t={'start>NEAR':[20,25],'NEAR>start':[20,25],'NEAR>end':[20,25],'start>ACROSS':[300,420],'ACROSS>end':[300,420],'NEAR>ACROSS':[290,410],'ACROSS>NEAR':[290,410],'start>ONEWAY':[30,30],'ONEWAY>end':[75,60],'NEAR>ONEWAY':[15,10],'ONEWAY>NEAR':[45,40],'start>ISLAND':[null],'ISLAND>end':[null]};
 delete t['start>ISLAND'];delete t['ISLAND>end'];
 const m=fixtureMatrix(points(['NEAR','ACROSS','ONEWAY','ISLAND']),t);
 const cands=[stop('NEAR','P3',{service:90}),stop('ACROSS','P3',{lat:43.1,lon:-86.9}),stop('ONEWAY','P3',{service:90,windows:[{days:[5],start:'10:00',end:'12:00'}]}),stop('ISLAND','P3')];
 const r=planDay({inputs:validatePlanInputs({...base,breaks:[{label:'Lunch',earliest:'11:30',latest:'13:30',minutes:30}]}),candidates:cands,matrix:m,now:NOW});
 assert.equal(r.excluded.find(e=>e.stationId==='ISLAND').code,'unreachable');
 assert.equal(r.excluded.find(e=>e.stationId==='ACROSS').code,'return-deadline');
 const one=r.stops.find(s=>s.stationId==='ONEWAY');assert.ok(one,'access-window stop scheduled');
 assert.ok(one.serviceStartMs>=localToUtc('2026-10-09','10:00').ms&&one.serviceEndMs<=localToUtc('2026-10-09','12:00').ms);
 assert.ok(r.returnMs<=localToUtc('2026-10-09','17:00').ms);
 assert.equal(r.breaks.length,1);
 // Directed legs: the asymmetric pair yields different totals depending on direction.
 const ab=planDay({inputs:validatePlanInputs({...base,manualOrder:['NEAR','ONEWAY']}),candidates:cands,matrix:m,now:NOW}),ba=planDay({inputs:validatePlanInputs({...base,manualOrder:['ONEWAY','NEAR']}),candidates:cands,matrix:m,now:NOW});
 assert.notEqual(ab.totals.driveMin,ba.totals.driveMin);
 // Access window on another weekday excludes the stop.
 const sat=planDay({inputs:validatePlanInputs({...base,date:'2026-10-10'}),candidates:cands,matrix:m,now:NOW});
 assert.equal(sat.excluded.find(e=>e.stationId==='ONEWAY').code,'access-day');
});

// Synthetic forecast: calm and dry until 13:00 local, then gusty with rain chance.
function syntheticForecast(){
 const v=(start,h,value)=>({validTime:`${start}/PT${h}H`,value});
 return parseGridpoints({properties:{updateTime:'2026-10-08T10:00:00+00:00',
  temperature:{uom:'wmoUnit:degC',values:[v('2026-10-09T04:00:00+00:00',24,12)]},
  windSpeed:{uom:'wmoUnit:km_h-1',values:[v('2026-10-09T04:00:00+00:00',13,10),v('2026-10-09T17:00:00+00:00',11,35)]},
  windGust:{uom:'wmoUnit:km_h-1',values:[v('2026-10-09T04:00:00+00:00',13,20),v('2026-10-09T17:00:00+00:00',11,70)]},
  probabilityOfPrecipitation:{uom:'wmoUnit:percent',values:[v('2026-10-09T04:00:00+00:00',13,5),v('2026-10-09T17:00:00+00:00',11,60)]},
  quantitativePrecipitation:{uom:'wmoUnit:mm',values:[v('2026-10-09T04:00:00+00:00',13,0),v('2026-10-09T17:00:00+00:00',6,4)]},
  probabilityOfThunder:{values:[v('2026-10-09T04:00:00+00:00',24,0)]}}},{fetchedAt:'2026-10-08T11:00:00Z'});
}
test('reordering changes arrival-time weather; missing or stale forecasts never produce good-weather recommendations',()=>{
 const f=syntheticForecast(),t={};
 sym(t,'start','A',60,60);sym(t,'start','B',60,60);sym(t,'A','B',30,30);t['A>end']=t['A>start'];t['B>end']=t['B>start'];
 const m=fixtureMatrix(points(['A','B']),t);
 const exposed=stop('A','P3',{taskClass:'exposed',service:120}),simple=stop('B','P3',{taskClass:'inspection',service:120});
 const forecasts={A:{forecast:f,zones:['MIZ999']},B:{forecast:f,zones:['MIZ999']}};
 const ab=planDay({inputs:validatePlanInputs({...base,manualOrder:['A','B']}),candidates:[exposed,simple],matrix:m,forecasts,now:NOW});
 const ba=planDay({inputs:validatePlanInputs({...base,manualOrder:['B','A']}),candidates:[exposed,simple],matrix:m,forecasts,now:NOW});
 assert.equal(ab.stops.find(s=>s.stationId==='A').weather.status,'ok');
 assert.equal(ba.stops.find(s=>s.stationId==='A').weather.status,'caution','exposed task moved into the gusty afternoon');
 const auto=planDay({inputs:validatePlanInputs(base),candidates:[exposed,simple],matrix:m,forecasts,now:NOW});
 assert.equal(auto.stops[0].stationId,'A','improvement prefers the order with fewer weather cautions');
 // Adopted rules become hard constraints.
 const hard=planDay({inputs:validatePlanInputs({...base,manualOrder:['B','A'],rules:{exposed:{adopted:true,adoptedBy:'Synthetic owner'}}}),candidates:[exposed,simple],matrix:m,forecasts,now:NOW});
 assert.equal(hard.feasible,false);assert.match(hard.warnings.join(' '),/infeasible/);
 // No forecast: unknown, never ok.
 const none=planDay({inputs:validatePlanInputs(base),candidates:[exposed],matrix:m,forecasts:{},now:NOW});
 assert.equal(none.stops[0].weather.status,'unknown');
 const stale=evaluateWindow({...f,updateTime:'2026-10-01T00:00:00Z'},{startMs:localToUtc('2026-10-09','09:00').ms,endMs:localToUtc('2026-10-09','10:00').ms,taskClass:'inspection',rules:validateRules(),now:NOW});
 assert.equal(stale.status,'unknown');
 const noGust=evaluateWindow({...f,fields:{...f.fields,windGust:[]}},{startMs:localToUtc('2026-10-09','09:00').ms,endMs:localToUtc('2026-10-09','10:00').ms,taskClass:'inspection',rules:validateRules(),now:NOW});
 assert.equal(noGust.status,'unknown');assert.ok(noGust.unknown.includes('windGust'),'missing gusts are unknown, not calm');
 const qpfBeyond=evaluateWindow(f,{startMs:localToUtc('2026-10-09','16:00').ms,endMs:localToUtc('2026-10-09','20:00').ms,taskClass:'inspection',rules:validateRules(),now:NOW});
 assert.ok(qpfBeyond.unknown.includes('qpf'));
 // Days compared: urgent work on the earliest feasible day even when a later day has better weather.
 const d1={...auto,date:'2026-10-09',stops:auto.stops.map(s=>({...s,tier:'P2',weather:{...s.weather,status:'caution'}})),score:[0,0,0,0,4,120],weatherSummary:{caution:2}};
 const d2={...auto,date:'2026-10-10',stops:auto.stops.map(s=>({...s,tier:'P2'})),score:[0,0,0,0,0,120],weatherSummary:{ok:2}};
 const cmp=compareDays([d2,d1]);
 assert.equal(cmp.recommendation.date,'2026-10-09');
 assert.equal(cmp.alternatives[0].date,'2026-10-10');assert.match(cmp.alternatives[0].consequence,/Waiting 1 day/);
 // Alerts overlapping the window are matched by zone.
 const alerts=parseAlerts({features:[{properties:{id:'a1',event:'Wind Advisory',severity:'Moderate',onset:'2026-10-09T12:00:00Z',ends:'2026-10-09T22:00:00Z',geocode:{UGC:['MIZ999']}}}]});
 assert.equal(alertsFor(alerts,{zones:['MIZ999'],startMs:localToUtc('2026-10-09','09:00').ms,endMs:localToUtc('2026-10-09','10:00').ms}).length,1);
 assert.equal(alertsFor(alerts,{zones:['MIZ001'],startMs:localToUtc('2026-10-09','09:00').ms,endMs:localToUtc('2026-10-09','10:00').ms}).length,0);
});

test('no feasible day yields actionable blockers; DST and date boundaries are correct',()=>{
 const t={};sym(t,'start','FAR',400,500);t['FAR>end']=t['FAR>start'];
 const m=fixtureMatrix(points(['FAR']),t);
 const r1=planDay({inputs:validatePlanInputs(base),candidates:[stop('FAR','P2',{skills:['tower']})],matrix:m,now:NOW});
 const r2=planDay({inputs:validatePlanInputs({...base,date:'2026-10-10'}),candidates:[stop('FAR','P2')],matrix:m,now:NOW});
 const cmp=compareDays([r1,r2]);
 assert.equal(cmp.recommendation,null);
 assert.ok(cmp.noFeasible.blockers.some(b=>b.code==='skills'));assert.ok(cmp.noFeasible.blockers.some(b=>b.code==='return-deadline'));
 assert.ok(cmp.noFeasible.decisions.length>=2);
 // Fall-back day (Nov 1, 2026): 08:00 EST departure is 13:00Z; the day before 08:00 EDT is 12:00Z.
 const fall=planDay({inputs:validatePlanInputs({...base,date:'2026-11-01'}),candidates:[],matrix:m,now:NOW});
 assert.equal(new Date(fall.departMs).toISOString(),'2026-11-01T13:00:00.000Z');
 assert.equal(new Date(localToUtc('2026-10-31','08:00').ms).toISOString(),'2026-10-31T12:00:00.000Z');
 assert.equal(localToUtc('2026-11-01','01:30').ambiguous,true);
 assert.equal(localToUtc('2026-03-08','02:30').skipped,true);
 assert.throws(()=>validatePlanInputs({...base,date:'2026-02-30'}));
 assert.throws(()=>validatePlanInputs({...base,returnByLocal:'07:00'}));
});

test('navigation links carry coordinates only and split legs for mobile waypoint limits; ORS matrices normalize nulls',()=>{
 const stops=[{label:'Base',lat:42.7,lon:-84.5},...Array.from({length:6},(_,i)=>({label:'S'+i,lat:43+i/10,lon:-84.5,accessNotes:'GATE-CODE-SENTINEL'})),{label:'Base',lat:42.7,lon:-84.5}];
 const links=navigationLinks(stops);
 assert.ok(links.google.length>=2);for(const l of links.google){const u=new URL(l.url);assert.ok((u.searchParams.get('waypoints')||'').split('|').filter(Boolean).length<=3);}
 assert.equal(links.apple.length,7);
 assert.ok(![...links.google,...links.apple].some(l=>l.url.includes('SENTINEL')));
 const m=normalizeOrsMatrix({durations:[[0,600,null],[650,0,300],[null,280,0]],distances:[[0,9000,null],[9100,0,4000],[null,3900,0]],sources:[{snapped_distance:5},{snapped_distance:450},{snapped_distance:2}]},[{id:'start',lat:42.7,lon:-84.5},{id:'A',lat:43,lon:-84.5},{id:'end',lat:42.7,lon:-84.5}]);
 assert.deepEqual(m.unreachable,[{from:'start',to:'end'},{from:'end',to:'start'}]);
 assert.equal(m.durations[0][1],600);assert.equal(m.durations[1][0],650,'directed');
 assert.equal(m.points[1].snappedDistanceM,450);
 assert.equal(m.traffic,'none');
});

test('accepted plans become outdated on new urgent incidents, closures and forecast updates without being rewritten',()=>{
 const plan={status:'accepted',date:'2026-10-09',result:{stops:[{stationId:'A',incidentIds:['i1']}]},snapshot:{incidents:{i1:{tier:'P3',title:'A'}},forecasts:{A:{updateTime:'2026-10-08T10:00:00Z'}}}};
 const reasons=planOutdated(plan,{incidents:[{id:'i2',scope:'station',tier:'P2',confidence:'confirmed',state:'new',body:{title:'B',stations:['B']}}],forecastUpdates:{A:'2026-10-08T16:00:00Z'},now:NOW});
 assert.deepEqual(reasons.map(r=>r.code).sort(),['forecast-updated','incident-closed','new-urgent']);
 assert.equal(plan.result.stops.length,1,'itinerary untouched');
});
