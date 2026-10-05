import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../worker.mjs';
import {session,authenticate,changePassword,passwordHash,validEmail,digest} from '../auth.mjs';
import {parseBody} from '../validation.mjs';
import {saveDoc,readDoc} from '../storage.mjs';
import {newVisit,validateVisit,prepareRestore,parseStationData} from '../../web/field-notes/field-core.mjs';
import retiredApi from '../../api/index.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');for(const name of ['0001_fleet.sql','0002_credential_generation.sql','0003_compact_visit_summaries.sql','0004_invalid_legacy_visit_ids.sql'])sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const reads=[];let queue=Promise.resolve();
 const DB={prepare(query){const stmt=sql.prepare(query);let values=[];return {bind(...v){values=v;return this;},async first(){reads.push({query,values});return stmt.get(...values)||null;},async all(){reads.push({query,values});return {results:stmt.all(...values)};},async run(){return {meta:{changes:Number(stmt.run(...values).changes)}};}};},batch(stmts){const run=queue.then(async()=>{sql.exec('BEGIN');try{const results=[];for(const s of stmts)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}});queue=run.catch(()=>{});return run;}};
 const env={DB,OWNER_EMAIL:'owner@example.com',ALLOWED_ORIGINS:'https://atolldb.com'};
 return {DB,env,sql,reads,async call(path,{token,body,method='GET',ip='192.0.2.1'}={}){return worker.fetch(new Request('https://fleet.test/api/'+path,{method,headers:{'CF-Connecting-IP':ip,...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);},async user(role='editor'){
  const u={id:crypto.randomUUID(),email:role+'@example.com',name:'Synthetic '+role,role,salt:'synthetic-test-salt',credential_version:0,password_hash:await passwordHash('old-synthetic-password', 'synthetic-test-salt')};
  await DB.prepare('INSERT INTO users(id,email,name,role,password_hash,salt,created) VALUES(?,?,?,?,?,?,?)').bind(u.id,u.email,u.name,u.role,u.password_hash,u.salt,new Date().toISOString()).run();return u;
 }};
}
test('old login snapshots cannot issue sessions after a password change',async()=>{
 const f=fixture(),u=await f.user(),oldToken=(await session(f.DB,u)).token;
 await changePassword(f.env,u,{currentPassword:'old-synthetic-password',password:'new-synthetic-password'});
 await assert.rejects(session(f.DB,u),e=>e.status===401);
 assert.equal(await authenticate(new Request('https://fleet.test',{headers:{Authorization:'Bearer '+oldToken}}),f.env),null);
 const res=await f.call('auth/login',{method:'POST',body:{email:u.email,password:'new-synthetic-password'}});assert.equal(res.status,200);
 assert.equal((await f.call('state',{token:(await res.json()).token})).status,200);
});
test('an actually delayed old-password login fails after concurrent rotation',async()=>{
 const f=fixture(),u=await f.user(),originalPrepare=f.DB.prepare.bind(f.DB);let unblock,captured;
 const gate=new Promise(r=>unblock=r),seen=new Promise(r=>captured=r);
 f.DB.prepare=query=>{const s=originalPrepare(query);if(query.startsWith('SELECT * FROM users WHERE email=')){const first=s.first.bind(s);s.first=async()=>{const row=await first();captured();await gate;return row;};}return s;};
 const login=f.call('auth/login',{method:'POST',body:{email:u.email,password:'old-synthetic-password'}});await seen;
 await changePassword(f.env,u,{currentPassword:'old-synthetic-password',password:'new-synthetic-password'});unblock();assert.equal((await login).status,401);
});
test('a stale password change cannot overwrite credentials or revoke new sessions',async()=>{
 const f=fixture(),u=await f.user();await changePassword(f.env,u,{currentPassword:'old-synthetic-password',password:'winning-synthetic-password'});
 const current=await f.DB.prepare('SELECT * FROM users WHERE id=?').bind(u.id).first(),token=(await session(f.DB,current)).token;
 await assert.rejects(changePassword(f.env,u,{currentPassword:'old-synthetic-password',password:'stale-synthetic-password'}),e=>e.status===409);
 assert.equal((await f.call('state',{token})).status,200);
 assert.equal((await f.call('auth/login',{method:'POST',body:{email:u.email,password:'winning-synthetic-password'}})).status,200);
});
test('disable and re-enable invalidate snapshots as well as existing sessions',async()=>{
 const f=fixture(),owner=await f.user('owner'),u=await f.user(),token=(await session(f.DB,owner)).token;
 for(const active of [false,true])assert.equal((await f.call('team/users/'+u.id,{token,method:'PATCH',body:{active}})).status,200);
 await assert.rejects(session(f.DB,u),e=>e.status===401);
});
test('email rotation is stopped by the aggregate IP budget before new hash work',async()=>{
 const f=fixture(),key='auth-ip:'+await digest('192.0.2.1');await f.DB.prepare('INSERT INTO attempts(key,count,expires) VALUES(?,?,?)').bind(key,40,Date.now()+900000).run();
 for(const email of ['random1@example.com','random2@example.com'])assert.equal((await f.call('auth/login',{method:'POST',body:{email,password:'synthetic-only'}})).status,429);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM attempts WHERE key LIKE 'auth:%'").get().n,0);
 assert.equal((await f.call('auth/login',{method:'POST',ip:'192.0.2.2',body:{email:'random3@example.com',password:'synthetic-only'}})).status,401);
});
test('email and current-password bounds reject alternate oversized input forms',async()=>{
 const f=fixture();for(const email of ['a'+'.'.repeat(5000)+'@example.com',{},null,[]])assert.equal((await f.call('auth/register',{method:'POST',body:{email,name:'Synthetic',password:'synthetic-password'}})).status,400);
 assert.equal(validEmail('  Person@Example.com  '),true);assert.equal(validEmail('a@@example.com'),false);
 const u=await f.user();await assert.rejects(changePassword(f.env,u,{currentPassword:'x'.repeat(257),password:'new-synthetic-password'}),e=>e.status===403);
 assert.equal(f.sql.prepare("SELECT count(*) n FROM attempts WHERE key LIKE 'password:%'").get().n,0);
});
test('shared hashing admission rejects excess concurrent work and frees normal slots',async()=>{
 const f=fixture();for(let i=0;i<4;i++)await f.DB.prepare('INSERT INTO locks(name,owner,expires) VALUES(?,?,?)').bind('auth-kdf:held'+i,'test',Date.now()+60000).run();
 assert.equal((await f.call('auth/login',{method:'POST',body:{email:'absent@example.com',password:'synthetic-only'}})).status,429);
});
test('streamed byte limits cancel overflow without trusting content length',async()=>{
 let canceled=false;const chunks=[new TextEncoder().encode('{"x":"'),new Uint8Array(40)];
 const body=new ReadableStream({pull(c){if(chunks.length)c.enqueue(chunks.shift());else c.close();},cancel(){canceled=true;}});
 await assert.rejects(parseBody({headers:new Headers({'Content-Length':'1'}),body},16),e=>e.status===413);assert.equal(canceled,true);
 const json='{"x":"é"}',bytes=new TextEncoder().encode(json).byteLength;
 assert.deepEqual(await parseBody(new Request('https://test',{method:'POST',body:json}),bytes),{x:'é'});
 await assert.rejects(parseBody(new Request('https://test',{method:'POST',body:json}),bytes-1),e=>e.status===413);
 for(const value of ['null','[]','{broken'])await assert.rejects(parseBody(new Request('https://test',{method:'POST',body:value})),e=>e.status===400);
});
const visit=()=>({...newVisit(),status:'complete',fields:{siteName:'Synthetic station',date:'2026-10-05',technicians:'Synthetic tech',notes:'Original'},sources:{airTemp:{column:'AirTC',value:12,rawValue:12,edited:false}},history:[]});
test('visit publication preserves provenance, returns revisions and blocks stale writes',async()=>{
 const f=fixture(),u=await f.user(),token=(await session(f.DB,u)).token,v=visit();v.photos=[{dataUrl:'synthetic-local-only'}];
 let res=await f.call('visits',{token,method:'POST',body:{visit:v}});assert.equal(res.status,200);const first=await res.json();
 let saved=await (await f.call('visits/'+v.id,{token})).json();assert.deepEqual(saved.sources,v.sources);assert.deepEqual(saved.photos,[]);assert.equal(saved._revision,first.revision);
 v.fields.notes='Newer';res=await f.call('visits',{token,method:'POST',body:{visit:v,revision:first.revision}});assert.equal(res.status,200);
 for(const revision of [undefined,first.revision])assert.equal((await f.call('visits',{token,method:'POST',body:{visit:{...v,fields:{...v.fields,notes:'Stale'}},revision}})).status,409);
 assert.equal((await readDoc(f.DB,'visit:'+v.id)).body.fields.notes,'Newer');
 const summary=(await (await f.call('visits',{token})).json())[0];assert.equal(summary.fields.notes,undefined);assert.equal(summary.sources,undefined);
});
test('concurrent initial publication has one winner and cannot upsert over it',async()=>{
 const f=fixture(),token=(await session(f.DB,await f.user())).token,v=visit();
 const replies=await Promise.all([f.call('visits',{token,method:'POST',body:{visit:v}}),f.call('visits',{token,method:'POST',body:{visit:{...v,fields:{...v.fields,notes:'Other'}}}})]);
 assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
});
test('malformed visit fields, excessive text and nested metadata are rejected before persistence',async()=>{
 const f=fixture(),token=(await session(f.DB,await f.user())).token;
 const deep={x:{x:{x:{x:{x:{x:'bad'}}}}}};
 for(const patch of [{fields:{siteName:{bad:true},date:'2026-10-05'}},{fields:{siteName:'Test',date:true}},{fields:{siteName:'Test',date:'2026-10-05',notes:'x'.repeat(10001)}},{sources:{airTemp:deep}},{history:null}]){
  const v={...visit(),...patch};assert.equal((await f.call('visits',{token,method:'POST',body:{visit:v}})).status,400);assert.equal(await readDoc(f.DB,'visit:'+v.id),null);
 }
});
test('invalid evidence comparison forms perform no history or product reads',async()=>{
 const f=fixture(),token=(await session(f.DB,await f.user())).token;
 for(const comparisonIds of ['S1',{id:'S1'},Array(6).fill('S1'),['bad/id']]){
  f.reads.length=0;assert.equal((await f.call('investigations',{token,method:'POST',body:{station:'S0',title:'Synthetic',notes:'Synthetic notes',comparisonIds}})).status,400);
  assert.equal(f.reads.some(r=>r.values.some(v=>typeof v==='string'&&/^cache:(history|product):/.test(v))),false);
 }
});
test('backup preparation rejects dates and malformed history before any commit',()=>{
 const original=visit();for(const patch of [{fields:{...original.fields,date:true}},{history:null},{sources:{airTemp:null}}])assert.throws(()=>prepareRestore({format:'FieldNotesBackup',schemaVersion:2,visits:[{...original,...patch}],photos:[]}));
 assert.equal(validateVisit(original),original);assert.equal(prepareRestore({format:'FieldNotesBackup',schemaVersion:2,visits:[original],photos:[]}).visits.length,1);
});
test('logger mapping rejects wide CSV and Campbell JSON while ordinary imports still work',()=>{
 assert.throws(()=>parseStationData('TIMESTAMP,'+Array(256).fill('x').join(',')+'\n2026-10-05 12:00:00,'+Array(256).fill('1').join(',')),/256 columns/);
 assert.throws(()=>parseStationData(JSON.stringify({head:{fields:Array(257).fill({name:'x'})},data:[]})),/256 columns/);
 assert.equal(parseStationData('TIMESTAMP,AirTC\n2026-10-05 12:00:00,12').columns[0].value,'12');
});
test('retired migration ignores even a configured historical token and writes nothing',async()=>{
 const f=fixture();f.env.MIGRATION_TOKEN='synthetic-old-token';assert.equal((await f.call('migration',{method:'POST',body:{visits:[visit()]}})).status,410);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM documents').get().n,0);
});
test('legacy Vercel entry never opens a database or issues a session',()=>{
 for(const url of ['/health','/api/auth/sign_in','/api/projects/other/rows']){let body='';const res={setHeader(){},end(v){body=v;}};retiredApi({url,method:'POST'},res);assert.equal(res.statusCode,410);assert.equal(JSON.parse(body).error,'legacy_api_retired');}
});
test('workspace exports paginate before reading all document bodies',async()=>{
 const f=fixture(),u=await f.user(),token=(await session(f.DB,u)).token;
 for(let i=0;i<52;i++){const id=String(i).padStart(3,'0');await saveDoc(f.DB,'record:'+id,'issue',{id,notes:'synthetic'},{id});}
 f.reads.length=0;const first=await (await f.call('export',{token})).json();assert.equal(first.records.length,50);assert.equal(first.nextCursor,'record:049');assert.equal(f.reads.filter(r=>r.query.includes('c.data FROM documents')&&r.values[0].startsWith('record:')).length,50);
 const second=await (await f.call('export?cursor='+first.nextCursor,{token})).json();assert.equal(second.records.length,2);assert.equal(second.nextCursor,null);assert.equal((await f.call('export?cursor=bad!',{token})).status,400);
});
test('restoring a colliding visit preserves entries under a new unpublished ID',()=>{
 const visit={...newVisit(),publishedRevision:'synthetic-revision'};const restored=prepareRestore({format:'FieldNotesBackup',schemaVersion:2,visits:[visit],photos:[]},new Set([visit.id]),()=> 'new-synthetic-id');assert.equal(restored.visits[0].id,'new-synthetic-id');assert.equal(restored.visits[0].publishedRevision,undefined);assert.deepEqual(restored.visits[0].fields,visit.fields);
});

test('an undated draft remains reopenable and restorable',()=>{const visit=newVisit();visit.fields.date='';assert.equal(validateVisit(visit).fields.date,'');assert.equal(prepareRestore({format:'FieldNotesBackup',visits:[visit],photos:[]}).visits[0].fields.date,'');});

test('oversized local notebook text stays readable but cannot publish unbounded text',async()=>{const f=fixture(),u=await f.user(),token=(await session(f.DB,u)).token,visit=newVisit();visit.fields.notes='x'.repeat(10001);assert.equal(validateVisit(visit).fields.notes.length,10001);assert.equal(prepareRestore({format:'FieldNotesBackup',visits:[visit],photos:[]}).visits[0].fields.notes.length,10001);visit.status='complete';visit.fields.siteName='Synthetic station';assert.equal((await f.call('visits',{token,method:'POST',body:{visit}})).status,400);});
test('invalid historical identities are preserved outside active visit lists',async()=>{const f=fixture(),bad='x'.repeat(10001);await saveDoc(f.DB,'visit:'+bad,'visit',{id:bad},{id:bad,fields:{notes:'synthetic'}});f.sql.exec(readFileSync(new URL('../migrations/0003_compact_visit_summaries.sql',import.meta.url),'utf8'));f.sql.exec(readFileSync(new URL('../migrations/0004_invalid_legacy_visit_ids.sql',import.meta.url),'utf8'));assert.equal(f.sql.prepare("SELECT type FROM documents WHERE key=?").get('visit:'+bad).type,'legacy-visit');assert.equal((await readDoc(f.DB,'visit:'+bad)).body.id,bad);const u=await f.user(),token=(await session(f.DB,u)).token;assert.deepEqual(await (await f.call('visits',{token})).json(),[]);assert.equal((await (await f.call('export',{token})).json()).records.length,0);});
