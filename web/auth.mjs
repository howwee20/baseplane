import {API_BASE} from './config.js';
let token='';try{token=sessionStorage.getItem('fleet-session')||'';}catch{}
let generation=0;const pending=new Set();
export const hasSession=()=>!!token;
export const sessionGeneration=()=>generation;
export function setSession(value){generation++;for(const controller of pending)controller.abort();pending.clear();token=value;try{if(value)sessionStorage.setItem('fleet-session',value);else sessionStorage.removeItem('fleet-session');}catch{}window.dispatchEvent(new CustomEvent('fleet-session-changed'));}
const canceled=()=>new DOMException('Session changed.','AbortError');
async function fetchCurrent(path,options={},asBlob=false){
 const version=generation,controller=new AbortController();pending.add(controller);
 const signal=AbortSignal.any([controller.signal,options.signal||AbortSignal.timeout(60000)]);
 try{
  const res=await fetch(API_BASE+'/'+path.replace(/^\//,''),{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...options.headers},signal});
  if(version!==generation||signal.aborted)throw canceled();
  let data;if(asBlob&&res.ok)data=await res.blob();else data=await res.json();
  if(version!==generation||signal.aborted)throw canceled();
  if(!res.ok){const error=new Error(data.error||'Request failed.');error.status=res.status;if(res.status===401&&!path.startsWith('auth/'))window.dispatchEvent(new CustomEvent('fleet-auth-required'));throw error;}
  return data;
 }finally{pending.delete(controller);}
}
export const request=(path,options={})=>fetchCurrent(path,options);
export async function signOut(){
 const formerToken=token;setSession('');
 if(formerToken)try{await fetch(API_BASE+'/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+formerToken},signal:AbortSignal.timeout(10000),keepalive:true});}catch{}
}
export async function downloadFromAPI(path,filename){
 const version=generation;let blob;
 if(path==='export'){
  let combined,cursor='',bytes=0;const seen=new Set();
  do{const page=await request('export'+(cursor?'?cursor='+encodeURIComponent(cursor):''));bytes+=new TextEncoder().encode(JSON.stringify(page)).byteLength;if(bytes>64*1024*1024)throw Error('Workspace export exceeds 64 MB. Download individual records or visits.');if(!combined)combined=page;else{combined.records.push(...page.records);combined.visits.push(...page.visits);}cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Export changed while downloading. Retry.');seen.add(cursor);}while(cursor);
  delete combined.nextCursor;blob=new Blob([JSON.stringify(combined)],{type:'application/json'});
 }else if(path==='ops/export'){
  const out={schemaVersion:1,kind:'enviroweather-fleet-operations-export',exportedAt:new Date().toISOString(),incidents:[],work:[],plans:[],notes:[],profiles:[],overrides:[]};let next={kind:'incidents',offset:0},bytes=0,pages=0;
  while(next){const page=await request(`ops/export?kind=${next.kind}&offset=${next.offset}`);bytes+=new TextEncoder().encode(JSON.stringify(page.rows)).byteLength;if(bytes>64*1024*1024||++pages>2000)throw Error('Operations export exceeds 64 MB.');out[page.page.kind].push(...page.rows);next=page.next;}
  blob=new Blob([JSON.stringify(out)],{type:'application/json'});
 }else blob=await fetchCurrent(path,{},true);
 if(version!==generation||!hasSession())throw canceled();
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
export function showAuth(root,onSuccess){
 const fragment=new URLSearchParams(location.hash.slice(1)),invite=fragment.get('invite'),setup=fragment.get('setup'),register=!!(invite||setup),inviteToken=invite||setup||'';
 if(inviteToken)history.replaceState(null,'',location.pathname);
 root.innerHTML=`<div class="auth-layout"><section class="auth-context"><img src="/field-notes/enviroweather-logo.png" alt="Enviroweather" width="44" height="44"><h1>Enviroweather Fleet</h1><p>Station diagnostics</p><a href="/field-notes/">Open your offline field notebook</a></section><section class="auth-panel"><h2>${register?'Create your account':'Sign in'}</h2><form id="auth-form">${register?'<div class="field"><label for="auth-name">Name</label><input id="auth-name" name="name" required autocomplete="name" maxlength="100"></div>':''}<div class="field"><label for="auth-email">Email</label><input id="auth-email" name="email" type="email" required autocomplete="username" inputmode="email" maxlength="254"></div><div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" required autocomplete="${register?'new-password':'current-password'}" ${register?'minlength="14"':''} maxlength="256">${register?'<span class="text-muted" style="font-size:12px">Use at least 14 characters.</span>':''}</div><p id="auth-error" class="auth-error" role="alert"></p><button class="primary" type="submit">${register?'Create account':'Sign in'}</button></form><p class="footnote">${register?'':'Ask the owner for an invitation.'}</p></section></div>`;
 root.querySelector('#auth-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button'),err=root.querySelector('#auth-error');b.disabled=true;err.textContent='';try{const values=Object.fromEntries(new FormData(e.target));const r=await request('auth/'+(register?'register':'login'),{method:'POST',body:JSON.stringify({...values,token:inviteToken})});setSession(r.token);await onSuccess(r.user);}catch(error){err.textContent=error.message;}finally{b.disabled=false;}};
}
