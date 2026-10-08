// Pure front-end logic: routes, reading semantics, release stamping. SYNTHETIC station data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseRoute} from '../../web/lib/routes.mjs';
import {reading,stationReadings,markerReading,stationHealth,formatValue,cardinal} from '../../web/lib/readings.mjs';
import {stampModule,stampHtml,stampSite} from '../../scripts/stamp-release.mjs';
import {permuteMatrix,canonicalOrder,normalizeOrsMatrix} from '../../web/lib/fleet/routing.mjs';

test('every older deep link resolves to its new destination; unknown routes return to the map',()=>{
 const U='00000000-0000-4000-8000-000000000000';
 const cases={'':{dest:'map'},'#/overview':{redirect:'#/map'},'#/review':{redirect:'#/attention'},'#/alerts':{redirect:'#/attention/changes'},'#/anomalies':{redirect:'#/records/references'},'#/tracker':{redirect:'#/records/tracker'},'#/stations':{redirect:'#/records/stations'},'#/planner':{redirect:'#/trips/compare'},'#/plans':{redirect:'#/trips'},['#/plan/'+U]:{redirect:'#/trip/'+U},'#/issues':{redirect:'#/records/investigations'},'#/visits':{redirect:'#/records/visits'},'#/bench':{redirect:'#/tools/logger'},'#/connections':{redirect:'#/settings'},'#/records':{redirect:'#/records/investigations'},'#/station/TST01':{dest:'map',panel:'station',id:'TST01'},'#/station/TST01/details':{dest:'map',page:'station',id:'TST01'},['#/incident/'+U]:{dest:'map',page:'incident',id:U},['#/packet/'+U]:{dest:'trips',page:'packet',id:U},'#/trips/new':{dest:'trips',panel:'trips',view:'edit'},['#/trip/'+U]:{dest:'trips',panel:'trips',view:'trip',id:U},'#/attention/qc':{dest:'map',panel:'attention',tab:'qc'},'#/team':{dest:'admin',page:'team'},'#/station/<script>':{redirect:'#/map'},'#/nope':{redirect:'#/map'}};
 for(const [h,want] of Object.entries(cases))assert.deepEqual(parseRoute(h),want,h);
});

const now=Date.parse('2026-10-08T02:15:00Z'),t=m=>new Date(now-m*60000).toISOString();
const st=(fields,extra={})=>({id:'TST01',name:'Synthetic 1',archiveStatus:'ACTIVE',lat:43,lon:-85,fields:fields.map(([key,value,unit,age,qc=[],qcStatus=null])=>({key,variable:key.replace(/_value_\d+d?$/,''),value,unit,time:t(age),qc,qcStatus,derived:/d$/.test(key)})),...extra});
test('readings convert only expected units, keep observation times, and never present flagged, stale or future values as current',()=>{
 const s=st([['air_temp_value_1',14.6,'Celsius',10],['relative_humidity_value_1',0,'%',10,[1]],['wind_speed_value_1',1.3,'m/s',300],['wind_direction_value_1',250,'Degrees',10],['precip_accum_one_hour_value_1',0,'Millimeters',20],['solar_radiation_value_1',0,'W/m**2',20],['dew_point_temperature_value_1d',8.6,'Celsius',10],['volt_value_1',13.1,'Fahrenheit-ish',10],['soil_temp_value_1',12,'Celsius',-20]]);
 const r=Object.fromEntries(stationReadings(s,{now,staleMinutes:180}).map(x=>[x.variable,x]));
 assert.equal(r.air_temp.value.text,'58.3');assert.equal(r.air_temp.value.unit,'°F');assert.equal(r.air_temp.time,t(10));assert.equal(r.air_temp.flagged,false);
 assert.equal(r.relative_humidity.flagged,true,'QC flag preserved');assert.equal(r.relative_humidity.value.text,'0','zero is a value, not missing');
 assert.equal(r.wind_speed.stale,true);assert.equal(r.precip_accum_one_hour.value.text,'0.00');assert.equal(r.solar_radiation.value.text,'0','night-time zero solar is valid');
 assert.equal(r.dew_point_temperature.value.unit,'°F','derived dew point shown with its own time');
 assert.equal(r.volt.value.unexpectedUnit,true,'an unexpected unit is shown raw, not converted');assert.equal(r.volt.value.unit,'Fahrenheit-ish');
 assert.equal(r.soil_temp.future,true);
 assert.equal(markerReading(s,'air_temp',{now}).text,'58');
 assert.equal(markerReading(s,'relative_humidity',{now}).text,'','flagged values never appear on markers');
 assert.equal(markerReading(s,'wind_speed',{now}).text,'','stale values never appear on markers');
 assert.equal(markerReading(s,'soil_temp',{now}).text,'');
 assert.equal(cardinal(250),'WSW');assert.equal(formatValue('air_temp',null,'Celsius'),null,'null is missing, not zero');
 assert.equal(reading(st([]),'air_temp',{now}),null);
});
test('station health keeps outage, sensor, QC and delayed distinct and follows the server queue',()=>{
 const s=st([['air_temp_value_1',10,'Celsius',10]]);
 const ops=(tier,extra={})=>({queue:[{id:'00000000-0000-4000-8000-000000000001',scope:'station',stations:['TST01'],effectiveTier:tier,confidence:'confirmed',...extra}],health:{}});
 assert.equal(stationHealth(s,ops('P1')).code,'out');assert.equal(stationHealth(s,ops('P2')).code,'out');
 assert.equal(stationHealth(s,ops('P3')).code,'sensor');assert.equal(stationHealth(s,ops('P4')).code,'sensor');
 assert.equal(stationHealth(s,ops('QC',{id:'qc:TST01'})).code,'qc');assert.equal(stationHealth(s,ops('QC',{id:'qc:TST01'})).incidentId,null,'a QC review is not an equipment incident');
 assert.equal(stationHealth(s,{queue:[],health:{TST01:{reporting:'delayed',ageMinutes:75}}}).code,'delayed');
 assert.equal(stationHealth({...s,archiveStatus:'INACTIVE'},ops('P2')).code,'inactive');
 assert.equal(stationHealth(s,{queue:[],health:{TST01:{reporting:'reporting'}}}).code,'ok');
});
test('release stamping gives every module one versioned URL and precaches exactly that set',()=>{
 assert.equal(stampModule("import {a} from './x.mjs';import b from '../y.js?v=old';const c=await import('./z.mjs');import 'leaflet';",'abc1234'),"import {a} from './x.mjs?v=abc1234';import b from '../y.js?v=abc1234';const c=await import('./z.mjs?v=abc1234');import 'leaflet';");
 assert.equal(stampHtml('<link href="/styles.css?v=ui-2"><script src="/app.js"></script><img src="https://x.test/a.js">','r1'),'<link href="/styles.css?v=r1"><script src="/app.js?v=r1"></script><img src="https://x.test/a.js">');
 const dir=mkdtempSync(join(tmpdir(),'stamp-'));mkdirSync(join(dir,'lib'));
 writeFileSync(join(dir,'index.html'),'<script type="module" src="/app.js"></script><link rel="stylesheet" href="/styles.css">');
 writeFileSync(join(dir,'app.js'),"import {x} from './lib/x.mjs';");writeFileSync(join(dir,'lib','x.mjs'),"export const x=1;");writeFileSync(join(dir,'styles.css'),'');
 writeFileSync(join(dir,'sw.js'),"const CACHE='enviroweather-fleet-dev';\nconst ASSETS=['/'];\n");
 stampSite(dir,'abc1234');
 assert.match(readFileSync(join(dir,'app.js'),'utf8'),/\.\/lib\/x\.mjs\?v=abc1234/);
 const sw=readFileSync(join(dir,'sw.js'),'utf8');assert.match(sw,/enviroweather-fleet-abc1234/);for(const a of ['/app.js?v=abc1234','/lib/x.mjs?v=abc1234','/styles.css?v=abc1234'])assert.ok(sw.includes(a),a);
 assert.throws(()=>stampSite(dir,'bad id!'));
});
test('road matrices fetched in canonical order map back to any stop order (reordering never needs a new request)',()=>{
 const pts=[{id:'start',lat:42.7,lon:-84.5},{id:'A',lat:44.5,lon:-86.1},{id:'B',lat:43.6,lon:-85.3},{id:'end',lat:42.7,lon:-84.5}];
 const order=canonicalOrder(pts),canon=order.map(i=>({...pts[i],id:'p'+i}));
 const dur=(a,b)=>a===b?0:Math.round(Math.abs(a.lat-b.lat)*3600+Math.abs(a.lon-b.lon)*1800+(a.lat<b.lat?60:0));
 const m=normalizeOrsMatrix({durations:canon.map(a=>canon.map(b=>dur(a,b))),distances:canon.map(a=>canon.map(b=>dur(a,b)*20))},canon);
 const back=permuteMatrix(m,pts,order);
 for(let i=0;i<pts.length;i++)for(let j=0;j<pts.length;j++)assert.equal(back.durations[i][j],dur(pts[i],pts[j]),`${pts[i].id}>${pts[j].id}`);
 const reordered=[pts[0],pts[2],pts[1],pts[3]];assert.deepEqual(canonicalOrder(reordered).map(i=>reordered[i].lat+','+reordered[i].lon),order.map(i=>pts[i].lat+','+pts[i].lon),'same canonical set');
});
