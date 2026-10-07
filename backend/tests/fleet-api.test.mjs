// End-to-end Worker tests with SYNTHETIC provider responses (Synoptic, NWS, OpenRouteService are mocked).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../worker.mjs';
import {digest} from '../auth.mjs';
import {runAssessment} from '../fleet.mjs';
import {MIGRATIONS} from './fixtures/migrations.mjs';
import {station,observe,UNITS} from './fixtures/fleet-fixtures.mjs';
import {distance} from '../../web/comparison.js';

function fixture(extraEnv={}){
 const sql=new DatabaseSync(':memory:');for(const name of MIGRATIONS)sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 let queue=Promise.resolve();
 const DB={prepare(query){const stmt=sql.prepare(query);let values=[];return {bind(...v){values=v;return this;},async first(){return stmt.get(...values)||null;},async all(){return {results:stmt.all(...values)};},async run(){return {meta:{changes:Number(stmt.run(...values).changes)}};}};},batch(stmts){const run=queue.then(async()=>{sql.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}});queue=run.catch(()=>{});return run;}};
 const env={DB,OWNER_EMAIL:'owner@example.com',ALLOWED_ORIGINS:'https://atolldb.com',SYNOPTIC_TOKEN:'synthetic-provider-secret',...extraEnv};
 const tokens={};
 return {env,sql,tokens,async session(role){const token=({owner:'a',editor:'b',viewer:'c'})[role].repeat(64),uid=crypto.randomUUID();await DB.prepare('INSERT INTO users(id,email,name,role,password_hash,salt,created) VALUES(?,?,?,?,?,?,?)').bind(uid,role+'@example.com','Synthetic '+role,role,'x','x',new Date().toISOString()).run();await DB.prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)').bind(await digest(token),uid,Date.now()+3600000).run();tokens[role]=token;return token;},
  async call(path,{role='editor',method='GET',body}={}){return worker.fetch(new Request('https://fleet.test/api/'+path,{method,headers:{Authorization:'Bearer '+this.tokens[role],'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);},
  async json(path,opts){const r=await this.call(path,opts);const t=await r.text();let b;try{b=JSON.parse(t);}catch{b=t;}return {status:r.status,body:b,headers:r.headers};}};
}
// Synthetic network: TST01/TST02 15 km apart (group), TST03 far away (single), TST04 sensors missing, TST05/06 fine.
const metas=[station(1,{xKm:0}),station(2,{xKm:15}),station(3,{xKm:250}),station(4,{xKm:120,yKm:40}),station(5,{xKm:60,yKm:-30}),station(6,{xKm:180,yKm:20})];
function providers(state){
 return async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.hostname==='api.synopticdata.com'){
   const now=Date.now();
   if(url.pathname.endsWith('/stations/metadata'))return Response.json({SUMMARY:{RESPONSE_CODE:1},STATION:metas});
   const per=state.scenario(now);
   return Response.json({SUMMARY:{RESPONSE_CODE:1},UNITS,STATION:metas.map(m=>observe(m,{obsAt:now-10*60000,...per[m.STID]}))});
  }
  if(url.hostname==='api.weather.gov'){
   state.nws++;
   if(url.pathname.startsWith('/points/'))return Response.json({properties:{gridId:'TST',gridX:10,gridY:20,forecastZone:'https://api.weather.gov/zones/forecast/MIZ999',county:'https://api.weather.gov/zones/county/MIC999',timeZone:'America/Detroit'}});
   if(url.pathname.startsWith('/gridpoints/')){const start=new Date(Math.floor(Date.now()/36e5)*36e5).toISOString().replace('.000Z','+00:00');const v=val=>({values:[{validTime:`${start}/P7D`,value:val}]});return Response.json({properties:{updateTime:new Date().toISOString(),temperature:{uom:'wmoUnit:degC',...v(12)},windSpeed:{uom:'wmoUnit:km_h-1',...v(10)},windGust:{uom:'wmoUnit:km_h-1',...v(20)},probabilityOfPrecipitation:{uom:'wmoUnit:percent',...v(10)},quantitativePrecipitation:{uom:'wmoUnit:mm',...v(0)},probabilityOfThunder:v(0),weather:{values:[]}}});}
   if(url.pathname.startsWith('/alerts/'))return Response.json({features:[]});
  }
  if(url.hostname==='api.openrouteservice.org'){
   state.ors++;assert.equal(init.headers.Authorization,'synthetic-ors-key');
   const body=JSON.parse(init.body);
   if(url.pathname.includes('/matrix/')){const L=body.locations.map(([lon,lat])=>({lat,lon}));return Response.json({durations:L.map((a,i)=>L.map((b,j)=>i===j?0:Math.round(distance(a,b)*1.3/80*3600*(i<j?1:1.05)))),distances:L.map(a=>L.map(b=>Math.round(distance(a,b)*1300))),sources:L.map(()=>({snapped_distance:20}))});}
   if(url.pathname.includes('/directions/'))return Response.json({features:[{geometry:{coordinates:body.coordinates},properties:{summary:{distance:1000,duration:600},segments:body.coordinates.slice(1).map(()=>({distance:500,duration:300}))}}]});
  }
  throw Error('Unexpected provider call: '+url.hostname);
 };
}
async function withProviders(f,state,fn){const original=globalThis.fetch;globalThis.fetch=providers(state);try{return await fn();}finally{globalThis.fetch=original;}}
// The Worker's refresh skips calls within 60 s of the previous snapshot; tests age the cached snapshot instead of waiting.
async function age(f,minutes=16){f.sql.prepare("UPDATE documents SET summary=summary WHERE key='cache:latest'").run();const row=f.sql.prepare("SELECT revision FROM documents WHERE key='cache:latest'").get();if(!row)return;const raw=f.sql.prepare("SELECT data FROM chunks WHERE key='cache:latest' AND revision=? ORDER BY part").all(row.revision).map(r=>Buffer.from(r.data,'base64')).reduce((a,b)=>Buffer.concat([a,b]),Buffer.alloc(0));const body=JSON.parse(raw.toString());body.sourceAt=new Date(Date.now()-minutes*60000).toISOString();const enc=Buffer.from(JSON.stringify(body)).toString('base64');f.sql.prepare("DELETE FROM chunks WHERE key='cache:latest' AND revision=?").run(row.revision);f.sql.prepare("INSERT INTO chunks(key,revision,part,data) VALUES(?,?,0,?)").run('cache:latest',row.revision,enc);}
const outage={obsAt:Date.now()-5*3600000};
const down=()=>({TST01:{obsAt:Date.now()-5*3600000},TST02:{obsAt:Date.now()-5*3600000},TST03:{obsAt:Date.now()-5*3600000},TST04:{drop:['volt_1','solar_radiation_1']}});

test('ingest → canonical queue across the API; acknowledgement, conflicts, work completion and recovery stay distinct',async()=>{
 const f=fixture();for(const r of ['owner','editor','viewer'])await f.session(r);
 const state={scenario:down,nws:0,ors:0};
 await withProviders(f,state,async()=>{for(let k=0;k<3;k++){assert.equal((await f.call('refresh',{method:'POST'})).status,200);await age(f);}});
 const s=(await f.json('state',{role:'viewer'})).body;
 assert.equal(s.ops.feed.status,'ok');
 assert.deepEqual(s.ops.queue.slice(0,3).map(q=>q.effectiveTier),['P1','P2','P3']);
 assert.equal(s.ops.counts.P1,1);assert.equal(s.ops.counts.P1Stations,2);assert.equal(s.ops.counts.P2,1);assert.equal(s.ops.counts.P3,1);
 assert.equal(s.ops.queue[0].members.length,2,'members nested, not double-counted');
 assert.ok(s.ops.detection.note.includes('not instantaneous'));
 const p2=s.ops.queue.find(q=>q.effectiveTier==='P2');
 // Acknowledge is not resolve; stale revisions conflict.
 let r=await f.json('ops/incidents/'+p2.id,{method:'PATCH',body:{revision:p2.revision,acknowledge:true,assignee:'Synthetic tech'}});
 assert.equal(r.status,200);assert.equal(r.body.state,'acknowledged');assert.notEqual(r.body.state,'resolved');
 assert.equal((await f.json('ops/incidents/'+p2.id,{method:'PATCH',body:{revision:p2.revision,assignee:'Someone else'}})).status,409);
 assert.equal((await f.json('ops/incidents/'+p2.id,{role:'viewer',method:'PATCH',body:{revision:r.body.revision,assignee:'x'}})).status,403);
 assert.equal((await f.json('ops/incidents/'+p2.id,{method:'PATCH',body:{revision:r.body.revision,state:'resolved'}})).status,400,'manual resolution needs a reason');
 // Work item: completion requires recorded work and does not resolve the incident.
 r=await f.json('ops/work',{method:'POST',body:{incidentId:p2.id,station:'TST03',template:'comms-power'}});assert.equal(r.status,201);const work=r.body;
 assert.equal(work.status,'proposed');assert.equal(work.workPerformed,null);assert.equal(work.estimateBasis,'template default (unconfirmed)');
 assert.equal((await f.json('ops/work/'+work.id,{method:'PATCH',body:{revision:work.revision,status:'done'}})).status,400);
 r=await f.json('ops/work/'+work.id,{method:'PATCH',body:{revision:work.revision,status:'done',workPerformed:{summary:'Synthetic: replaced fuse'}}});assert.equal(r.status,200);
 let inc=(await f.json('ops/incidents/'+p2.id)).body.incident;assert.notEqual(inc.state,'resolved','work completion does not invent recovery');
 const handoff=(await f.json('ops/work/'+work.id+'/handoff')).body;assert.equal(handoff.kind,'enviroweather-field-handoff');assert.equal(handoff.visit.stationId,'TST03');
 // Telemetry recovers for two new snapshots → resolved automatically, with a recovered alert.
 state.scenario=()=>({TST01:outage,TST02:outage,TST04:{drop:['volt_1','solar_radiation_1']}});
 await withProviders(f,state,async()=>{for(let k=0;k<2;k++){await f.call('refresh',{method:'POST'});await age(f);}});
 inc=(await f.json('ops/incidents/'+p2.id)).body.incident;assert.equal(inc.state,'resolved');assert.equal(inc.resolution,'telemetry-recovered');
 const alerts=(await f.json('ops/alerts',{role:'viewer'})).body.alerts;assert.ok(alerts.some(a=>a.kind==='recovered'&&a.incidentId===p2.id));
 assert.ok(alerts.filter(a=>a.kind==='new').length<=3,'one new alert per confirmed incident, none per group member');
 assert.equal((await f.json('ops/alerts/ack',{role:'viewer',method:'POST',body:{ids:[alerts[0].id]}})).status,403);
 assert.equal((await f.json('ops/alerts/ack',{method:'POST',body:{ids:[alerts[0].id]}})).status,200);
 const events=(await f.json('ops/incidents/'+p2.id)).body.events.map(e=>e.type);
 for(const t of ['created','confirmed','acknowledged','assigned','work-created','work-updated','resolved'])assert.ok(events.includes(t),t);
});

test('duplicate assessment jobs for the same ingest are idempotent',async()=>{
 const f=fixture(),now=Date.now(),latest={STATION:metas.map(m=>observe(m,{obsAt:now-600000,...(m.STID==='TST03'?outage:{})})),UNITS},snap={metadata:{STATION:metas},latest,ingestId:'synthetic-ingest-1',retrievedAt:new Date(now).toISOString(),thresholds:{delayed:60,stale:180}};
 const [a,b]=await Promise.all([runAssessment(f.env,snap),runAssessment(f.env,snap)]);
 assert.ok(a.skipped||b.skipped);const c=await runAssessment(f.env,snap);assert.match(c.skipped,/Already assessed|Another/);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM incidents WHERE scope='station' AND station='TST03'").get().n,1);
});

test('planner endpoints: honest blockers without routing; real itinerary with routing; accepted plans are never rewritten',async()=>{
 const f=fixture();for(const r of ['owner','editor','viewer'])await f.session(r);
 const state={scenario:down,nws:0,ors:0};
 await withProviders(f,state,async()=>{for(let k=0;k<3;k++){await f.call('refresh',{method:'POST'});await age(f);}});
 const date=new Date(Date.now()+864e5).toISOString().slice(0,10),inputs={date,start:{label:'Synthetic base',lat:43,lon:-85.1},departLocal:'07:00',returnByLocal:'19:00',maxWorkdayMinutes:720,crew:{label:'Crew A',skills:['electronics']}};
 let ctx=await withProviders(f,state,()=>f.json('ops/plans/context',{method:'POST',body:{inputs}}));
 assert.equal(ctx.status,200);assert.equal(ctx.body.matrix,null);assert.match(ctx.body.routing.error,/ORS_API_KEY/);
 assert.equal((await withProviders(f,state,()=>f.json('ops/plans',{method:'POST',body:{inputs}}))).status,503);
 assert.equal(state.ors,0,'no routing calls without credentials');
 f.env.ORS_API_KEY='synthetic-ors-key';
 ctx=await withProviders(f,state,()=>f.json('ops/plans/context',{method:'POST',body:{inputs}}));
 assert.ok(ctx.body.matrix);assert.ok(ctx.body.candidates.length>=3);
 assert.deepEqual(ctx.body.candidates.slice(0,3).map(c=>c.tier),['P1','P1','P2']);
 assert.ok(Object.values(ctx.body.forecasts).some(x=>x.forecast));
 const created=await withProviders(f,state,()=>f.json('ops/plans',{method:'POST',body:{inputs,title:'Synthetic day'}}));
 assert.equal(created.status,201);const plan=created.body;
 assert.ok(plan.result.stops.length>=3);assert.deepEqual(plan.result.stops.filter(s=>s.tier==='P1').map(s=>s.stationId).sort(),['TST01','TST02']);
 // The distant P2 cannot fit after both P1 stops: it is excluded with an exact reason and surfaced, never silently dropped.
 const p2=plan.result.stops.find(s=>s.stationId==='TST03')||plan.result.excluded.find(e=>e.stationId==='TST03');
 assert.ok(p2);if(!plan.result.stops.some(s=>s.stationId==='TST03'))assert.ok(plan.result.exceptions.some(e=>e.type==='urgent-not-scheduled'&&e.stationId==='TST03'));
 assert.ok(plan.navigation.google.length>=1);assert.ok(plan.routing.attribution.includes('openrouteservice'));
 const orsCalls=state.ors;
 const again=await withProviders(f,state,()=>f.json('ops/plans/context',{method:'POST',body:{inputs}}));assert.equal(state.ors,orsCalls,'matrix served from cache');assert.ok(again.body.matrix.cached);
 let r=await f.json('ops/plans/'+plan.id,{method:'PATCH',body:{revision:plan.revision,status:'accepted'}});assert.equal(r.status,200);
 assert.equal((await f.json('ops/plans/'+plan.id,{method:'PATCH',body:{revision:r.body.revision,order:plan.result.stops.map(s=>s.stationId).reverse()}})).status,400);
 assert.equal((await f.json('ops/plans/'+plan.id,{method:'PATCH',body:{revision:plan.revision,title:'stale'}})).status,409);
 const csv=await f.call('ops/plans/'+plan.id+'/export?format=csv',{role:'viewer'});assert.equal(csv.headers.get('Content-Type'),'text/csv; charset=utf-8');assert.match(await csv.text(),/order,station_id/);
 // A second crew cannot silently duplicate accepted stops.
 const dup=await withProviders(f,state,()=>f.json('ops/plans/context',{method:'POST',body:{inputs:{...inputs,crew:{label:'Crew B',skills:['electronics']}}}}));
 assert.ok(dup.body.candidates.filter(c=>c.alreadyPlanned).length>=3);
 // New urgent incident after acceptance marks the plan outdated without rewriting it. (TST03 recovers so fewer than
 // half the synthetic network is silent; otherwise the engine correctly treats the snapshot as a provider problem.)
 state.scenario=()=>({TST01:outage,TST02:outage,TST06:outage});
 await withProviders(f,state,async()=>{for(let k=0;k<3;k++){await f.call('refresh',{method:'POST'});await age(f);}});
 const view=(await f.json('ops/plans/'+plan.id,{role:'viewer'})).body;
 assert.ok(view.outdated.some(o=>o.code==='new-urgent'));assert.ok(view.outdated.some(o=>o.code==='incident-closed'));assert.equal(view.result.stops.length,plan.result.stops.length);
 assert.equal((await f.json('ops/plans',{role:'viewer',method:'POST',body:{inputs}})).status,403);
});

test('station notes keep gate codes from viewers and URLs; operations export paginates with the same redaction',async()=>{
 const f=fixture();for(const r of ['owner','editor','viewer'])await f.session(r);
 await withProviders(f,{scenario:()=>({}),nws:0,ors:0},async()=>{await f.call('refresh',{method:'POST'});});
 let r=await f.json('ops/notes/TST01',{method:'PUT',body:{accessNotes:'Synthetic: north gate',gateCode:'SYNTH-1234',entrance:{lat:43.001,lon:-85.002,label:'Gate'},accessWindows:[{days:[1,2,3,4,5],start:'08:00',end:'16:00'}],region:'Synthetic North',importance:2}});
 assert.equal(r.status,200);
 assert.equal((await f.json('ops/notes/TST01',{method:'PUT',body:{accessNotes:'stale',revision:'not-current'}})).status,409);
 assert.equal((await f.json('ops/notes/TST01',{role:'viewer'})).body.gateCode,null);
 assert.equal((await f.json('ops/notes/TST01',{role:'editor'})).body.gateCode,'SYNTH-1234');
 const exp=(await f.json('ops/export?kind=notes',{role:'viewer'})).body;assert.equal(JSON.stringify(exp).includes('SYNTH-1234'),false);assert.ok(exp.next);
 const detail=(await f.json('ops/stations/TST01',{role:'viewer'})).body;assert.equal(detail.notes.gateCode,null);assert.ok(detail.coverage.rows.length);assert.ok(detail.health.channels.length);
 // Team profile edits need a reason and a current revision.
 const row=detail.profile.find(p=>p.channel==='volt_1');
 assert.equal((await f.json('ops/profiles/TST01/volt_1',{method:'PATCH',body:{revision:row.revision,expected:'removed'}})).status,400);
 assert.equal((await f.json('ops/profiles/TST01/volt_1',{method:'PATCH',body:{revision:row.revision,expected:'removed',reason:'Synthetic: voltage channel retired'}})).status,200);
 assert.equal((await f.json('ops/profiles/TST01/volt_1',{method:'PATCH',body:{revision:row.revision,expected:'expected',reason:'stale edit'}})).status,409);
 assert.equal((await f.json('ops/settings',{role:'editor',method:'POST',body:{fleet:{outageConfirmCount:3}}})).status,403);
 assert.equal((await f.json('ops/settings',{role:'owner',method:'POST',body:{fleet:{grouping:{linkKm:500}}}})).status,400);
 assert.equal((await f.json('ops/settings',{role:'owner',method:'POST',body:{fleet:{outageConfirmCount:3}}})).body.fleet.outageConfirmCount,3);
});

test('a refresh and assessment of a 104-station network stays within the D1 per-invocation query budget',async()=>{
 const f=fixture();await f.session('editor');
 // Count every statement D1 would execute, including each statement inside a batch (Cloudflare counts those too).
 let count=0;const prepare=f.env.DB.prepare.bind(f.env.DB),batch=f.env.DB.batch.bind(f.env.DB);
 f.env.DB.prepare=q=>{const s=prepare(q);for(const m of ['first','all','run']){const o=s[m].bind(s);s[m]=(...a)=>{if(!s._inBatch)count++;return o(...a);};}return s;};
 f.env.DB.batch=stmts=>{count+=stmts.length;stmts.forEach(x=>x._inBatch=true);return batch(stmts);};
 const big=Array.from({length:104},(_,i)=>station(i+1,{xKm:(i%13)*25,yKm:Math.floor(i/13)*25,status:i>=99?'INACTIVE':'ACTIVE'}));
 const original=globalThis.fetch;globalThis.fetch=async input=>{const url=new URL(input instanceof Request?input.url:String(input));if(url.pathname.endsWith('/stations/metadata'))return Response.json({SUMMARY:{RESPONSE_CODE:1},STATION:big});return Response.json({SUMMARY:{RESPONSE_CODE:1},UNITS,STATION:big.map((m,i)=>observe(m,{obsAt:Date.now()-(i<4?5*3600000:600000),...(i===10?{drop:['volt_1','solar_radiation_1']}:{})}))});};
 const runs=[];
 try{for(let k=0;k<3;k++){count=0;assert.equal((await f.call('refresh',{method:'POST'})).status,200);runs.push(count);await age(f);}}finally{globalThis.fetch=original;}
 const profiles=f.sql.prepare("SELECT length(body) n FROM fleet_blobs WHERE key='profiles'").get().n;
 assert.ok(runs.every(n=>n<=50),`statements per refresh: ${runs.join(', ')} (Workers Free allows 50, Paid 1000)`);
 assert.ok(profiles<1_800_000,'profile blob stays well under the 2 MB row limit');
 assert.ok(f.sql.prepare("SELECT count(*) n FROM incidents WHERE scope='group'").get().n>=1);
 console.log(`D1 statements per refresh+assessment (first, second, third): ${runs.join(', ')}; profile blob ${profiles} bytes`);
});
