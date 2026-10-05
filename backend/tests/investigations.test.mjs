import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionReasons,captureEvidence,handoff,handoffText} from '../../web/lib/investigations.mjs';
import {reference} from '../../web/comparison.js';

const time='2026-10-02T16:00:00.000Z';
function fixture(){
 const station=(id,lat=44,value=10)=>({id,name:'Synthetic '+id,lat,lon:-85,archiveStatus:'ACTIVE',status:'stale',ageMinutes:200,flagged:true,last:time,fields:[{key:'air_temp_value_1',variable:'air_temp',value,unit:'Celsius',time,qc:[2],qcStatus:'failed',derived:false}]});
 const stations=[station('TEST'),station('NEAR1',44.01),station('NEAR2',44.02)];
 const network={stations,connection:{delayed:60,stale:180},fetchedAt:time,cacheAgeMinutes:4,qcSummary:{QC_NAMES:{2:'Synthetic flag'}}};
 const histories=new Map(stations.map((s,i)=>[s.id,{at:time,body:{UNITS:{air_temp:'Celsius'},QC_SUMMARY:{QC_NAMES:{2:'Synthetic flag'}},STATION:[{STID:s.id,OBSERVATIONS:{date_time:[time,'2026-10-02T16:05:00.000Z'],air_temp_set_1:[null,10+i]},QC:{air_temp_set_1:[[],[]]}}]}}]));
 return {network,histories,getHistory:id=>histories.get(id)};
}
test('triage reasons retain both freshness and QC context without claiming a fault',()=>{
 const {network}=fixture();const reasons=attentionReasons(network.stations[0],network.connection);
 assert.equal(reasons.length,2);assert.match(reasons[0],/200 minutes.*180 minutes/);assert.match(reasons[1],/QC flag/);
 assert.match(attentionReasons({...network.stations[0],status:'inactive'})[0],/excluded/);
});
test('capture preserves timestamps, actual history coverage, units, missing source values and QC provenance',()=>{
 const f=fixture();const snapshot=captureEvidence({...f,stationId:'TEST',comparisonIds:['NEAR1','NEAR2'],now:time});
 assert.equal(snapshot.capturedAt,time);assert.equal(snapshot.networkFetchedAt,time);assert.equal(snapshot.window.requestedHours,24);
 assert.deepEqual(snapshot.histories[0].sourceValues,[null,10]);assert.deepEqual(snapshot.histories[0].qc,[[],[]]);assert.equal(snapshot.histories[0].windowStart,time);assert.equal(snapshot.histories[0].points[0].value,10);assert.equal(snapshot.histories[0].unit,'Celsius');
 assert.equal(snapshot.comparison.reference.median,11.5);assert.equal(snapshot.comparison.reference.delta,-1.5);
 f.network.stations[0].fields[0].value=999;assert.equal(snapshot.station.fields[0].value,10);
});
test('missing history, unknown units and disallowed neighbor IDs cannot manufacture a reference',()=>{
 const f=fixture();f.histories.delete('NEAR2');const snapshot=captureEvidence({...f,stationId:'TEST',comparisonIds:['NEAR1','NEAR2']});
 assert.equal(snapshot.histories[2].available,false);assert.equal(snapshot.comparison.reference,null);
 f.histories.get('TEST').body.UNITS={};assert.equal(captureEvidence({...f,stationId:'TEST',comparisonIds:['NEAR1']}).comparison.reference,null);
 assert.equal(reference({unit:undefined,points:[{t:1,v:3}]},[{unit:undefined,points:[{t:1,v:4}]},{unit:undefined,points:[{t:1,v:5}]}]),null);
 assert.throws(()=>captureEvidence({...f,stationId:'TEST',comparisonIds:['OUTSIDE']}),/nearest active/);
 assert.throws(()=>captureEvidence({...f,stationId:'TEST',hours:1}),/Supported evidence/);
 assert.throws(()=>captureEvidence({...f,stationId:'TEST',variable:'../invalid'}),/Unsupported evidence variable/);
 const target=f.histories.get('TEST').body;target.UNITS.volt='Volts';target.STATION[0].OBSERVATIONS.volt_set_1=[12.2,12.3];assert.equal(captureEvidence({...f,stationId:'TEST',variable:'volt'}).histories[0].points[1].value,12.3);
});
test('handoffs retain case, planned checks, evidence and limits in human-readable and structured formats',()=>{
 const f=fixture(),e=captureEvidence({...f,stationId:'TEST'}),record={id:'case-1',title:'Synthetic review',station:'TEST',status:'open',notes:'Check reference first.',plannedChecks:'Bring reference instrument.',evidence:[e],activity:[{at:time,action:'Investigation created',status:'open'}]};
 const json=handoff(record,time),text=handoffText(record,time);
 assert.equal(json.kind,'enviroweather-field-handoff');assert.equal(json.visit.stationId,'TEST');assert.equal(json.visit.plannedChecks,record.plannedChecks);assert.equal(json.evidence.length,1);
 assert.match(text,/For human review/);assert.match(text,/Bring reference instrument/);assert.match(text,/air_temp_value_1: 10 Celsius/);assert.match(text,/Network fetched/);assert.match(text,/QC 2/);
});
