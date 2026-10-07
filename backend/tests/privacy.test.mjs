import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../worker.mjs';
import {digest} from '../auth.mjs';
import {readDoc,saveDoc} from '../storage.mjs';
import {MIGRATIONS} from './fixtures/migrations.mjs';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const name of MIGRATIONS)sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare(query){const stmt=sql.prepare(query);let values=[];return {bind(...v){values=v;return this;},async first(){return stmt.get(...values)||null;},async all(){return {results:stmt.all(...values)};},async run(){return {meta:{changes:Number(stmt.run(...values).changes)}};}};},async batch(stmts){sql.exec('BEGIN');try{const results=[];for(const s of stmts)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB,OWNER_EMAIL:'owner@example.com',ALLOWED_ORIGINS:'https://atolldb.com',SYNOPTIC_TOKEN:'synthetic-provider-secret-only'};
 return {env,async call(path,{token,method='GET',body}={}){return worker.fetch(new Request('https://fleet.test/api/'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);},async session(role){const id=crypto.randomUUID(),token=role==='owner'?'a'.repeat(64):role==='editor'?'b'.repeat(64):'c'.repeat(64);await DB.prepare('INSERT INTO users(id,email,name,role,password_hash,salt,created) VALUES(?,?,?,?,?,?,?)').bind(id,role+'@example.com','Synthetic '+role,role,'unused','unused',new Date().toISOString()).run();await DB.prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)').bind(await digest(token),id,Date.now()+60000).run();return token;}};
}
const privateEndpoints=[['state'],['anomalies'],['reference?station=TEST'],['history?station=TEST'],['products?station=TEST&service=qcsegments'],['records/private'],['records/private/handoff'],['visits'],['visits/private'],['export'],['team'],['refresh','POST'],['thresholds','POST'],['records','POST'],['records/private','PATCH'],['records/private/evidence','POST'],['investigations','POST'],['visits','POST'],['team/invites','POST'],['team/users/private','PATCH'],
 ['ops/settings'],['ops/incidents'],['ops/incidents/00000000-0000-4000-8000-000000000000'],['ops/alerts'],['ops/stations/TEST'],['ops/notes/TEST'],['ops/work'],['ops/work/00000000-0000-4000-8000-000000000000'],['ops/work/00000000-0000-4000-8000-000000000000/handoff'],['ops/routing'],['ops/forecast?stations=TEST'],['ops/plans'],['ops/plans/00000000-0000-4000-8000-000000000000'],['ops/plans/00000000-0000-4000-8000-000000000000/export?format=csv'],['ops/export'],
 ['ops/settings','POST'],['ops/incidents/00000000-0000-4000-8000-000000000000','PATCH'],['ops/incidents/00000000-0000-4000-8000-000000000000/merge','POST'],['ops/incidents/00000000-0000-4000-8000-000000000000/split','POST'],['ops/alerts/ack','POST'],['ops/profiles/TEST/air_temp_1','PATCH'],['ops/notes/TEST','PUT'],['ops/reference-overrides','POST'],['ops/reference-overrides/00000000-0000-4000-8000-000000000000/remove','POST'],['ops/work','POST'],['ops/work/00000000-0000-4000-8000-000000000000','PATCH'],['ops/plans/context','POST'],['ops/plans','POST'],['ops/plans/00000000-0000-4000-8000-000000000000','PATCH'],['ops/plans/00000000-0000-4000-8000-000000000000/copy','POST']];

test('every private data, QC, handoff and edit route rejects anonymous and invalid sessions',async()=>{
 const f=fixture();await saveDoc(f.env.DB,'record:private','issue',{id:'private',notes:'PRIVATE-NOTE-SENTINEL'});
 for(const [path,method]of privateEndpoints)for(const token of [undefined,'d'.repeat(64)]){
  const res=await f.call(path,{method,token});assert.equal(res.status,401,path);assert.equal(res.headers.get('Cache-Control'),'no-store');assert.equal((await res.text()).includes('PRIVATE-NOTE-SENTINEL'),false,path);
 }
});
test('viewers cannot perform any team write; editors cannot manage members or invite owners',async()=>{
 const f=fixture(),viewer=await f.session('viewer'),editor=await f.session('editor');
 for(const [path,method]of privateEndpoints.filter(([,method])=>method))assert.equal((await f.call(path,{method,token:viewer,body:{role:'owner'}})).status,403,path);
 for(const [path,method]of [['team','GET'],['team/invites','POST'],['team/users/private','PATCH'],['ops/settings','POST']])assert.equal((await f.call(path,{method,token:editor,...(method==='GET'?{}:{body:{role:'owner'}})})).status,403,path);
});
test('a missing bootstrap secret never permits a predictable fallback owner token',async()=>{
 const f=fixture();const res=await f.call('auth/register',{method:'POST',body:{name:'Synthetic owner',email:f.env.OWNER_EMAIL,password:'synthetic-password-only-123',token:'disabled'}});assert.equal(res.status,403);assert.equal(await f.env.DB.prepare("SELECT id FROM users WHERE role='owner'").first(),null);
});
test('record edits require a revision and leave existing notes intact on conflict',async()=>{
 const f=fixture(),token=await f.session('editor');const revision=await saveDoc(f.env.DB,'record:private','issue',{id:'private',kind:'issue',title:'Synthetic case',notes:'Original',status:'open'});
 const res=await f.call('records/private',{token,method:'PATCH',body:{notes:'Unversioned edit'}});assert.equal(res.status,409);assert.equal((await readDoc(f.env.DB,'record:private')).revision,revision);assert.equal((await readDoc(f.env.DB,'record:private')).body.notes,'Original');
});
async function savedNetwork(f){
 const at=new Date(Date.now()-3600000).toISOString(),station={STID:'TEST',NAME:'Synthetic station',STATUS:'ACTIVE',LATITUDE:44,LONGITUDE:-85,OBSERVATIONS:{air_temp_value_1:{value:12,date_time:at}}};
 for(const [key,data]of [['metadata',{STATION:[station]}],['latest',{STATION:[station],UNITS:{air_temp:'Celsius'}}]])await saveDoc(f.env.DB,'cache:'+key,'cache',{data,sourceAt:at});return at;
}
test('upstream outage preserves the last good snapshot and never exposes the provider key in errors',async()=>{
 const f=fixture(),token=await f.session('editor'),at=await savedNetwork(f),originalFetch=globalThis.fetch,originalError=console.error,logs=[];
 globalThis.fetch=async()=>{throw Error('Network failed at https://synthetic.test/?token='+f.env.SYNOPTIC_TOKEN);};console.error=(...args)=>logs.push(args.join(' '));
 try{const failed=await f.call('refresh',{token,method:'POST'});assert.equal(failed.status,500);assert.equal((await failed.text()).includes(f.env.SYNOPTIC_TOKEN),false);const res=await f.call('state',{token}),state=await res.json();assert.equal(state.fetchedAt,at);assert.equal(state.stations[0].fields[0].value,12);assert.match(state.lastError,/Saved observations remain available/);assert.equal(JSON.stringify(state).includes(f.env.SYNOPTIC_TOKEN),false);assert.equal(logs.join(' ').includes(f.env.SYNOPTIC_TOKEN),false);}finally{globalThis.fetch=originalFetch;console.error=originalError;}
});
test('partial upstream refresh cannot replace good metadata or observations with an incomplete result',async()=>{
 const f=fixture(),token=await f.session('editor'),at=await savedNetwork(f),originalFetch=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>++requests===1?Response.json({SUMMARY:{RESPONSE_CODE:1},STATION:[{STID:'REPLACEMENT'}]}):new Response('Unavailable',{status:503});
 try{assert.equal((await f.call('refresh',{token,method:'POST'})).status,503);const state=await (await f.call('state',{token})).json();assert.equal(state.fetchedAt,at);assert.equal(state.stations[0].id,'TEST');assert.equal((await readDoc(f.env.DB,'cache:metadata')).body.data.STATION[0].STID,'TEST');assert.match(state.lastError,/Saved observations remain available/);}finally{globalThis.fetch=originalFetch;}
});
test('private report and tracker return aligned cached comparisons to viewers without provider credentials',async()=>{
 const f=fixture(),token=await f.session('viewer'),now=Date.now(),at=new Date(now).toISOString(),stations=Array.from({length:4},(_,i)=>({STID:'S'+i,NAME:'Synthetic '+i,STATUS:'ACTIVE',LATITUDE:44,LONGITUDE:-85+i*0.02,OBSERVATIONS:{air_temp_value_1:{value:14+i*0.1,date_time:at}}}));
 for(const [key,data]of [['metadata',{STATION:stations}],['latest',{STATION:stations,UNITS:{air_temp:'Celsius'}}]])await saveDoc(f.env.DB,'cache:'+key,'cache',{data,sourceAt:at});
 for(let i=0;i<stations.length;i++)await saveDoc(f.env.DB,'cache:history:S'+i+':24','cache',{sourceAt:at,data:{UNITS:{air_temp:'Celsius'},STATION:[{OBSERVATIONS:{date_time:[new Date(now-3600000).toISOString(),at],air_temp_set_1:[10+i*0.1,14+i*0.1]},QC:{air_temp_set_1:[null,null]}}]}});
 let res=await f.call('anomalies',{token});assert.equal(res.status,200);const report=await res.json();assert.equal(report.stationCount,4);assert.equal(report.summary.inRange,4);
 res=await f.call('reference?station=S0&variable=air_temp&hours=24',{token});assert.equal(res.status,200);const tracker=await res.json();assert.equal(tracker.sources.length,4);assert.equal(tracker.summary.evaluated,2);assert.equal(tracker.weather.kind,'shared-change');assert.equal(tracker.weather.neighbors,3);assert.equal(JSON.stringify(tracker).includes(f.env.SYNOPTIC_TOKEN),false);
 assert.equal((await f.call('reference?station=S0&variable=air_temp&hours=1',{token})).status,400);assert.equal((await f.call('anomalies?radius=1000',{token})).status,400);
});
test('public Pages assets exclude private notebooks, credential files and maintenance seed payloads',()=>{
 const root=new URL('../../web/',import.meta.url);let files=0;
 function check(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=new URL(entry.name+(entry.isDirectory()?'/':''),dir);if(entry.isDirectory()){check(path);continue;}files++;assert.doesNotMatch(path.pathname,/(?:\.dev\.vars|\.env(?:\.|$)|\.sqlite|\.db$|secrets\.json|wrangler\.json)/);if(/\.(?:mjs|js|html|json)$/.test(entry.name)&&!path.pathname.includes('/vendor/')){const source=readFileSync(path,'utf8');assert.doesNotMatch(source,/Checklist item:|first-day checklist|SYNOPTIC_TOKEN\s*[:=]/);}}}check(root);assert.ok(files>10);
});
