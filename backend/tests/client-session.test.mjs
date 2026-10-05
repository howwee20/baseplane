import {test} from 'node:test';
import assert from 'node:assert/strict';
const original={window:globalThis.window,document:globalThis.document,sessionStorage:globalThis.sessionStorage,fetch:globalThis.fetch};
globalThis.window=new EventTarget();globalThis.sessionStorage={getItem:()=>'',setItem(){},removeItem(){}};
let downloads=0,downloadBlob;
globalThis.document={createElement:()=>({click(){downloads++;}})};
const auth=await import('../../web/auth.mjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function reset(t){downloads=0;downloadBlob=null;auth.setSession('synthetic-token');const fetch=globalThis.fetch;t.after(()=>{globalThis.fetch=fetch;auth.setSession('');});}
test('late private JSON cannot resolve after sign-out even if fetch ignores abort',async t=>{
 reset(t);const gate=deferred();let signal;globalThis.fetch=async (url,options)=>{signal=options.signal;return {ok:true,status:200,json:()=>gate.promise};};
 const result=auth.request('state');await Promise.resolve();auth.setSession('');gate.resolve({private:'synthetic-private-data'});await assert.rejects(result,e=>e.name==='AbortError');assert.equal(signal.aborted,true);
});
test('late 401 cannot expire a replacement session',async t=>{
 reset(t);const gate=deferred();let expired=0;const listener=()=>expired++;window.addEventListener('fleet-auth-required',listener);t.after(()=>window.removeEventListener('fleet-auth-required',listener));
 globalThis.fetch=()=>gate.promise;const result=auth.request('state');auth.setSession('replacement-synthetic-token');gate.resolve({ok:false,status:401,json:async()=>({error:'expired'})});await assert.rejects(result,e=>e.name==='AbortError');assert.equal(expired,0);assert.equal(auth.hasSession(),true);
});
test('late private blob does not start a download after sign-out',async t=>{
 reset(t);const gate=deferred();globalThis.fetch=async()=>({ok:true,status:200,blob:()=>gate.promise});const result=auth.downloadFromAPI('records/synthetic/handoff','synthetic.json');await Promise.resolve();auth.setSession('');gate.resolve(new Blob(['synthetic private notes']));await assert.rejects(result,e=>e.name==='AbortError');assert.equal(downloads,0);
});
test('ordinary private responses and paginated exports still work',async t=>{
 reset(t);const create=URL.createObjectURL,revoke=URL.revokeObjectURL,setTimer=globalThis.setTimeout;t.after(()=>{URL.createObjectURL=create;URL.revokeObjectURL=revoke;globalThis.setTimeout=setTimer;});URL.createObjectURL=blob=>{downloadBlob=blob;return 'blob:synthetic-test';};URL.revokeObjectURL=()=>{};globalThis.setTimeout=(callback,ms)=>{const timer=setTimer(callback,ms);timer.unref();return timer;};
 const paths=[];globalThis.fetch=async url=>{paths.push(url);return {ok:true,status:200,json:async()=>url.includes('cursor=')?{records:[],visits:[{id:'second'}],nextCursor:null}:{schemaVersion:2,records:[{id:'first'}],visits:[],nextCursor:'record:first'}};};
 await auth.downloadFromAPI('export','synthetic-workspace.json');assert.equal(downloads,1);assert.equal(paths.length,2);const data=JSON.parse(await downloadBlob.text());assert.equal(data.records[0].id,'first');assert.equal(data.visits[0].id,'second');assert.equal('nextCursor' in data,false);
});
