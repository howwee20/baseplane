import {test} from 'node:test';
import assert from 'node:assert/strict';
import {processSnapshot,processFailure} from '../../web/lib/fleet/pipeline.mjs';
import {assessStation} from '../../web/lib/fleet/health.mjs';
import {bootstrapProfile} from '../../web/lib/fleet/profiles.mjs';
import {sortByPriority,priorityKey,compareKeys} from '../../web/lib/fleet/priority.mjs';
import {clusterOutages} from '../../web/lib/fleet/grouping.mjs';
import {T0,station,observe,snapshot,UNITS} from './fixtures/fleet-fixtures.mjs';

// Simulates the Worker's persistence between ingests (synthetic data only).
function world(metas,config={}){
 let n=0;const w={profiles:{},states:{},incidents:new Map(),alerts:new Map(),events:[],ingests:0};
 w.run=(perStation={},{at=T0,id,omit=[]}={})=>{
  const {metadata,latest}=snapshot(metas,perStation,{omit});
  const r=processSnapshot({metadata,latest,ingestId:id||'ingest-'+(++w.ingests),retrievedAt:new Date(at).toISOString(),profiles:w.profiles,stationStates:w.states,incidents:[...w.incidents.values()],thresholds:{delayed:60,stale:180},config,ids:()=>'id-'+(++n)});
  for(const [s,rows] of Object.entries(r.profileRows))w.profiles[s]=rows;
  Object.assign(w.states,r.stationStates);for(const i of r.incidents){const {_new,_changed,_bump,...clean}=i;w.incidents.set(i.id,clean);}
  for(const a of r.alerts)if(!w.alerts.has(a.dedupe))w.alerts.set(a.dedupe,a);w.events.push(...r.events);return r;
 };
 w.open=()=>[...w.incidents.values()].filter(i=>i.state!=='resolved'&&i.state!=='merged');
 w.station=id=>w.open().find(i=>i.scope==='station'&&i.station===id);
 return w;
}
const old=h=>({obsAt:T0-h*3600000});
const step=k=>T0+k*15*60000;

test('tiers: group outage > isolated outage > multiple sensors > one sensor, in one canonical order',()=>{
 const metas=[station(1,{xKm:0}),station(2,{xKm:20}),station(3,{xKm:300}),station(4,{xKm:500}),station(5,{xKm:700}),station(6,{xKm:900})];
 const w=world(metas);
 const scenario=k=>({TST01:{obsAt:step(k)-5*3600000},TST02:{obsAt:step(k)-5*3600000},TST03:{obsAt:step(k)-5*3600000},TST04:{obsAt:step(k)-600000,drop:['wind_speed_1','solar_radiation_1','volt_1']},TST05:{obsAt:step(k)-600000,drop:['soil_moisture_1']}});
 for(let k=0;k<3;k++)w.run(scenario(k),{at:step(k)});
 const queue=w.open().filter(i=>i.scope!=='feed'&&!(i.scope==='station'&&i.groupId));
 const sorted=sortByPriority(queue.map(i=>({...i,stationCount:i.body.stations.length,sensorGroupCount:i.body.sensorGroups.length})),{now:step(2)});
 assert.deepEqual(sorted.map(i=>i.tier),['P1','P2','P3','P4']);
 assert.deepEqual(sorted[0].body.stations.sort(),['TST01','TST02']);
 assert.equal(sorted[1].station,'TST03');
 assert.equal(w.station('TST01').tier,'P1');
 // Many minor issues can never outrank a higher tier.
 const p4s=Array.from({length:50},(_,i)=>({id:'x'+i,tier:'P4',confidence:'confirmed',lastGood:'2020-01-01T00:00:00Z',stationCount:9,sensorGroupCount:9,importance:3}));
 assert.equal(sortByPriority([...p4s,{id:'p2',tier:'P2',confidence:'suspected',lastGood:new Date(step(2)).toISOString()}],{now:step(2)})[0].id,'p2');
});

test('one fresh channel cannot hide missing expected channels; a wind instrument counts once (provisional)',()=>{
 const meta=station(1);let profile=bootstrapProfile({stationId:'TST01',meta,latest:observe(meta),units:UNITS,now:T0}).rows;
 const live=observe(meta,{drop:['wind_speed_1','wind_gust_1','wind_direction_1','solar_radiation_1','soil_temp_1','soil_moisture_1','volt_1','precip_accum_one_hour_1']});
 const a=assessStation({station:live,profile,units:UNITS,now:T0});
 assert.equal(a.reporting,'reporting');
 assert.equal(a.issueKeys.length,8);
 assert.ok(a.issueGroups.some(g=>g.id==='wind@3.0'&&g.channels.length===3));
 assert.ok(a.provisionalGrouping);
 const windOnly=assessStation({station:observe(meta,{drop:['wind_speed_1','wind_gust_1','wind_direction_1']}),profile,units:UNITS,now:T0});
 assert.equal(windOnly.issueGroups.length,1,'speed, gust and direction are one provisional instrument');
 assert.equal(windOnly.issueKeys.length,3);
});

test('never-installed, dormant, retired and seasonal channels do not fault; a disappearing expected channel stays detectable',()=>{
 const meta=station(1,{never:[['air_temp','3','10.0'],['wind_speed','2','-0.1']],dormant:[['soil_moisture','2','-0.1']]});
 const boot=bootstrapProfile({stationId:'TST01',meta,latest:observe(meta),units:UNITS,now:T0});
 const by=Object.fromEntries(boot.rows.map(r=>[r.channel,r]));
 assert.equal(by.air_temp_3.expected,'never-reported');assert.equal(by.soil_moisture_2.expected,'dormant');assert.equal(by.air_temp_1.expected,'expected');
 let a=assessStation({station:observe(meta),profile:boot.rows,units:UNITS,now:T0});
 assert.deepEqual(a.issueKeys,[]);
 const retired=boot.rows.map(r=>r.channel==='soil_temp_1'?{...r,removed:'2026-09-01T00:00:00Z',source:'team'}:r.channel==='solar_radiation_1'?{...r,expected:'seasonal',seasonal:{months:[5,6,7,8]},source:'team'}:r);
 a=assessStation({station:observe(meta,{drop:['soil_temp_1','solar_radiation_1']}),profile:retired,units:UNITS,now:T0});
 assert.deepEqual(a.issueKeys,[]);
 // Later snapshots without the channel do not erase the expectation.
 const later=bootstrapProfile({stationId:'TST01',meta:{...meta,SENSOR_VARIABLES:{...meta.SENSOR_VARIABLES,volt:{}}},latest:observe(meta,{drop:['volt_1']}),units:UNITS,existing:boot.rows,now:T0+864e5});
 a=assessStation({station:observe(meta,{drop:['volt_1'],obsAt:T0+864e5-600000}),profile:later.rows,units:UNITS,now:T0+864e5});
 assert.deepEqual(a.issueKeys,['volt_1']);
 // A brand-new channel seen only today is provisional, not expected.
 const fresh=bootstrapProfile({stationId:'TST01',meta,latest:{...observe(meta),OBSERVATIONS:{...observe(meta).OBSERVATIONS,leaf_wet_value_1:{value:0,date_time:new Date(T0).toISOString()}}},units:UNITS,existing:boot.rows,now:T0});
 assert.equal(fresh.rows.find(r=>r.channel==='leaf_wet_1').expected,'provisional');
});

test('provider failures, partial and empty responses and stale cache never confirm station outages; last good survives',()=>{
 const metas=Array.from({length:10},(_,i)=>station(i+1,{xKm:i*10}));const w=world(metas);
 w.run({},{at:step(0)});
 const allOld=Object.fromEntries(metas.map(m=>[m.STID,{obsAt:step(1)-6*3600000}]));
 for(let k=1;k<=4;k++){const r=w.run(allOld,{at:step(k)});assert.equal(r.feedQuality,'degraded');}
 assert.ok(w.open().find(i=>i.scope==='feed'),'feed incident raised');
 assert.equal(w.open().filter(i=>i.scope==='station'&&i.confidence==='confirmed').length,0,'no confirmed station outages from a degraded feed');
 assert.equal(w.states.TST01.lastGoodAt,new Date(step(0)-600000).toISOString(),'last good evidence retained');
 assert.equal([...w.alerts.values()].filter(a=>a.kind==='new').length,0,'no alert storm');
 const failed=processFailure({ingestId:'fail-1',retrievedAt:new Date(step(5)).toISOString(),reason:'HTTP 503',incidents:[...w.incidents.values()]});
 assert.equal(failed.alerts.length,0,'existing feed incident is updated, not re-alerted');
 // Station omitted from an otherwise complete response: no new absence evidence for it.
 const w2=world(metas);w2.run({},{at:step(0)});
 for(let k=1;k<=4;k++)w2.run({},{at:step(k),omit:['TST03']});
 assert.equal(w2.states.TST03.outageCount,0);
 assert.ok(!w2.station('TST03')||w2.station('TST03').confidence!=='confirmed');
 // Coexisting station incident survives a later provider problem.
 const w3=world(metas);for(let k=0;k<3;k++)w3.run({TST05:{obsAt:step(k)-5*3600000}},{at:step(k)});
 assert.equal(w3.station('TST05').confidence,'confirmed');
 w3.run(allOld,{at:step(3)});
 assert.equal(w3.station('TST05').confidence,'confirmed','station incident is not hidden by the feed incident');
 assert.ok(w3.open().find(i=>i.scope==='feed'));
});

test('repeated snapshots do not advance confirmation; duplicate jobs create no duplicate incidents or alerts',()=>{
 const metas=[station(1),station(2,{xKm:400})];const w=world(metas);
 const out={TST01:{obsAt:T0-5*3600000}};
 w.run(out,{at:step(0),id:'same'});w.run(out,{at:step(0),id:'same'});w.run(out,{at:step(0),id:'same'});
 assert.equal(w.states.TST01.outageCount,1);assert.equal(w.station('TST01').confidence,'suspected');
 w.run(out,{at:step(1),id:'next'});assert.equal(w.station('TST01').confidence,'confirmed');
 const before=w.alerts.size;w.run(out,{at:step(1),id:'next'});w.run(out,{at:step(2),id:'third'});
 assert.equal(w.open().filter(i=>i.station==='TST01').length,1);
 assert.equal(w.alerts.size,before,'no repeated alerts while the outage persists');
 assert.equal([...w.alerts.values()].filter(a=>a.incidentId===w.station('TST01').id&&a.kind==='new').length,1);
});

test('grouping avoids chaining; merge/split overrides and partial recovery preserve identity and history',()=>{
 const line=Array.from({length:6},(_,i)=>({id:'S'+i,lat:43,lon:-85+i*30/81.4,onset:T0}));
 const clusters=clusterOutages(line,{linkKm:40,maxDiameterKm:100,onsetWindowMinutes:180});
 assert.ok(clusters.every(c=>c.diameterKm<=100),'no cluster exceeds the diameter cap');
 assert.ok(clusters.length>=2,'a 150 km chain is split');
 const late=clusterOutages([{id:'A',lat:43,lon:-85,onset:T0},{id:'B',lat:43,lon:-85.2,onset:T0+6*3600000}],{});
 assert.equal(late.filter(c=>!c.belowMinimum).length,0,'onsets hours apart are not grouped');
 const metas=[station(1,{xKm:0}),station(2,{xKm:15}),station(3,{xKm:30}),station(4,{xKm:300})];const w=world(metas);
 const down=k=>({TST01:{obsAt:step(k)-5*3600000},TST02:{obsAt:step(k)-5*3600000},TST03:{obsAt:step(k)-5*3600000}});
 for(let k=0;k<3;k++)w.run(down(k),{at:step(k)});
 const group=w.open().find(i=>i.scope==='group');assert.equal(group.body.stations.length,3);const gid=group.id;
 assert.equal([...w.alerts.values()].filter(a=>a.incidentId===gid&&a.kind==='new').length,1);
 assert.equal([...w.alerts.values()].filter(a=>a.kind==='new'&&['TST01','TST02','TST03'].includes(w.incidents.get(a.incidentId)?.station)).length,0,'members alert through the group');
 // Partial recovery: TST01 reports again.
 const partial=k=>({TST02:{obsAt:step(k)-5*3600000},TST03:{obsAt:step(k)-5*3600000}});
 for(let k=3;k<6;k++)w.run(partial(k),{at:step(k)});
 const g2=w.incidents.get(gid);assert.equal(g2.body.stations.length,2);assert.equal(g2.state,'new');
 assert.ok(g2.body.members.find(m=>m.id==='TST01').status!=='out');
 assert.equal(w.station('TST01'),undefined,'recovered member incident resolved');
 assert.equal(w.station('TST02').groupId,gid);
 // Split TST03 out as standalone with an audited override; group drops below two, remaining station becomes P2.
 const g3=w.incidents.get(gid);g3.body.overrides.excluded.push('TST03');w.station('TST03').body.optOutGrouping=true;
 w.run(partial(6),{at:step(6)});
 assert.equal(w.incidents.get(gid).telemetry,'partial-recovery');assert.equal(w.station('TST02').tier,'P2');assert.equal(w.station('TST03').tier,'P2');
 assert.ok(w.events.some(e=>e.incidentId===gid&&e.type==='member-recovered'));
 // Everything recovers -> group resolved with the same identity.
 for(let k=7;k<10;k++)w.run({},{at:step(k)});
 assert.equal(w.incidents.get(gid).state,'resolved');
 assert.equal(w.open().filter(i=>i.scope!=='feed').length,0);
});

test('zero rain, night solar and calm wind are valid; future timestamps and QC suspicion are distinct',()=>{
 const meta=station(1),profile=bootstrapProfile({stationId:'TST01',meta,latest:observe(meta),units:UNITS,now:T0}).rows;
 let a=assessStation({station:observe(meta,{values:{precip_accum_one_hour_1:0,solar_radiation_1:0,wind_speed_1:0}}),profile,units:UNITS,now:T0});
 assert.equal(a.reporting,'reporting');assert.deepEqual(a.issueKeys,[]);
 a=assessStation({station:observe(meta,{nulls:['precip_accum_one_hour_1']}),profile,units:UNITS,now:T0});
 assert.deepEqual(a.issueKeys,['precip_accum_one_hour_1'],'null is missing, not zero');
 a=assessStation({station:observe(meta,{future:['air_temp_1']}),profile,units:UNITS,now:T0});
 assert.equal(a.channels.find(c=>c.channel==='air_temp_1').state,'future');
 a=assessStation({station:observe(meta,{qc:{relative_humidity_1:[1]}}),profile,units:UNITS,now:T0});
 assert.equal(a.channels.find(c=>c.channel==='relative_humidity_1').state,'qc-suspect');
 assert.deepEqual(a.issueKeys,[],'QC suspicion is not a missing sensor');
 assert.ok(a.reasonCodes.includes('qc-suspect'));
 // Hourly channel 50 minutes behind a 5-minute channel is normal, 2 hours behind is stale.
 a=assessStation({station:observe(meta,{lag:{wind_speed_1:50,wind_gust_1:50,wind_direction_1:50}}),profile,units:UNITS,now:T0});
 assert.deepEqual(a.issueKeys,[]);
 a=assessStation({station:observe(meta,{lag:{volt_1:130}}),profile,units:UNITS,now:T0});
 assert.deepEqual(a.issueKeys,['volt_1']);
});

test('sensor issues escalate to a station outage in place and de-escalate on partial recovery',()=>{
 const w=world([station(1),station(2,{xKm:500})]);
 for(let k=0;k<2;k++)w.run({TST01:{obsAt:step(k)-600000,drop:['volt_1']}},{at:step(k)});
 const id=w.station('TST01').id;assert.equal(w.station('TST01').tier,'P4');
 for(let k=2;k<4;k++)w.run({TST01:{obsAt:step(k)-5*3600000}},{at:step(k)});
 assert.equal(w.station('TST01').id,id);assert.equal(w.station('TST01').tier,'P2');
 for(let k=4;k<7;k++)w.run({TST01:{obsAt:step(k)-600000,drop:['volt_1','solar_radiation_1']}},{at:step(k)});
 assert.equal(w.station('TST01').id,id);assert.equal(w.station('TST01').kind,'sensor');assert.equal(w.station('TST01').tier,'P3');
 assert.ok(w.events.some(e=>e.incidentId===id&&e.type==='escalated'));
 assert.ok(w.events.some(e=>e.incidentId===id&&e.type==='de-escalated'));
});

test('manual resolution without recovered telemetry reopens the same incident',()=>{
 const w=world([station(1),station(2,{xKm:500})]);
 for(let k=0;k<3;k++)w.run({TST01:{obsAt:step(k)-5*3600000}},{at:step(k)});
 const inc=w.station('TST01');Object.assign(inc,{state:'resolved',resolvedAt:new Date(step(2)).toISOString(),resolution:'manual'});
 w.run({TST01:{obsAt:step(3)-5*3600000}},{at:step(3)});
 assert.equal(w.station('TST01').id,inc.id);assert.equal(w.station('TST01').body.recurrence,1);
 assert.ok(w.events.some(e=>e.type==='reopened'&&/manual/.test(e.detail)));
});

test('priority key is deterministic and duration breaks ties within a tier',()=>{
 const a={id:'a',tier:'P2',confidence:'confirmed',lastGood:'2026-10-07T08:00:00Z'},b={id:'b',tier:'P2',confidence:'confirmed',lastGood:'2026-10-07T12:00:00Z'};
 assert.ok(compareKeys(priorityKey(a,{now:T0}),priorityKey(b,{now:T0}))<0);
 assert.equal(sortByPriority([b,a],{now:T0})[0].id,'a');
 const override={...b,tierOverride:{tier:'P1',reason:'Key research site',by:'Owner'}};
 assert.equal(sortByPriority([a,override],{now:T0})[0].id,'b');
});
