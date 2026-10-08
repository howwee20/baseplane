// Trips: choose a start, add stations, keep or optimize the order, see drive and visit time separately, save and
// reopen, then hand off to navigation. Road times come only from the routing provider; without it nothing is guessed.
import {PLAIN_TIER} from './lib/readings.mjs';
import {navigationLinks} from './lib/fleet/routing.mjs';
import {savePacket,getPacket,removePacket} from './lib/fleet/packets.mjs';
import {addDays,localDate} from './lib/fleet/time.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The day the displayed result is planned for, so times on another day say so. Reset per render; set from the result shown.
let tripDate=null;
const t=ms=>{if(!Number.isFinite(ms))return '—';const s=new Date(ms).toLocaleTimeString('en-US',{timeZone:'America/Detroit',hour:'numeric',minute:'2-digit'});if(!tripDate)return s;const d=localDate(ms);return d===tripDate?s:`${s} (${d>tripDate?'next day':'day before'})`;};
const dur=m=>!Number.isFinite(m)?'—':m<60?`${m} min`:`${Math.floor(m/60)} h ${String(m%60).padStart(2,'0')} min`;
const day=s=>s?new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}):'';
const WX={ok:'Weather within limits',caution:'Weather caution',unknown:'Weather unknown',blocked:'Weather blocks this task'};
const GLYPH={P1:'✕✕',P2:'✕',P3:'▲▲',P4:'▲',QC:'?',PM:'●'};
let T=null;
function fresh(){return {draft:null,preview:{ticket:0,loading:false,data:null,error:'',key:''},plans:{data:null,loading:false,error:''},trip:{id:null,data:null,loading:false,error:''},settings:null,settingsLoading:false,timer:null,user:null};}
T=fresh();
const draftKey=()=>'fleet-trip-draft:'+(T.user?.email||'');
function saveDraft(){try{localStorage.setItem(draftKey(),JSON.stringify(T.draft));}catch{}}
export function clearTripDraft(){try{for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(k?.startsWith('fleet-trip-draft:'))localStorage.removeItem(k);}}catch{}}
export function resetTrips(){clearTimeout(T?.timer);T=fresh();}
function newDraft(){const pd=T.settings?.planner||{};return {planId:null,revision:null,title:'',date:addDays(localDate(Date.now()),1),start:pd.bases?.[0]||null,end:null,departLocal:pd.departLocal||'07:30',returnByLocal:pd.returnByLocal||'17:30',maxWorkdayMinutes:pd.maxWorkdayMinutes||600,bufferMinutes:pd.bufferMinutes??10,breaks:pd.breaks||[{label:'Lunch',earliest:'11:30',latest:'13:30',minutes:30}],crew:{label:'Crew',skills:['electronics']},stops:[],visitMinutes:{}};}
function draft(user){
 T.user=user;
 if(!T.draft){try{T.draft=JSON.parse(localStorage.getItem(draftKey())||'null');}catch{}if(!T.draft)T.draft=newDraft();}
 return T.draft;
}
export const tripHas=id=>!!T.draft?.stops.includes(id);
export const tripStopCount=()=>T.draft?.stops.length||0;
export function toggleStop(id,user){const d=draft(user);d.stops=d.stops.includes(id)?d.stops.filter(s=>s!==id):[...d.stops,id];saveDraft();return d.stops.includes(id);}
function loadSettings(ctx){if(T.settings||T.settingsLoading)return;T.settingsLoading=true;ctx.api('ops/settings').then(s=>{T.settings=s;if(T.draft&&!T.draft.start&&s.planner?.bases?.[0]){T.draft.start=s.planner.bases[0];saveDraft();}}).catch(()=>{T.settings={planner:{},routing:null};}).finally(()=>{T.settingsLoading=false;ctx.repaint();});}
const inputsOf=d=>({date:d.date,start:d.start,end:d.end||d.start,departLocal:d.departLocal,returnByLocal:d.returnByLocal,maxWorkdayMinutes:d.maxWorkdayMinutes,bufferMinutes:d.bufferMinutes,breaks:d.breaks,crew:d.crew,visitMinutes:d.visitMinutes});
// Recalculate after edits. Each request carries a ticket; a slower, older response never replaces a newer one.
function schedule(ctx,{optimize=false,immediate=false}={}){
 clearTimeout(T.timer);const d=T.draft;
 if(!d.start||!d.stops.length){T.preview={...T.preview,data:null,error:'',loading:false,key:''};return;}
 const key=JSON.stringify([inputsOf(d),d.stops,optimize]);if(!optimize&&key===T.preview.key&&(T.preview.data||T.preview.loading))return;
 T.timer=setTimeout(async()=>{
  const ticket=++T.preview.ticket;T.preview.loading=true;T.preview.error='';ctx.repaint();
  try{const r=await ctx.api('ops/plans/preview',{method:'POST',body:JSON.stringify({inputs:inputsOf(d),stops:d.stops,optimize})});
   if(ticket!==T.preview.ticket)return;
   if(optimize&&r.order?.length){const missing=d.stops.filter(s=>!r.order.includes(s));d.stops=[...r.order,...missing];saveDraft();}
   T.preview={...T.preview,data:r,error:'',loading:false,key:JSON.stringify([inputsOf(d),d.stops,false])};
  }catch(e){if(ticket!==T.preview.ticket)return;T.preview={...T.preview,error:e.message,loading:false};}
  ctx.repaint();ctx.mapTrip?.();
 },immediate?0:450);
}
export function tripMapData(ctx,view){
 const st=id=>ctx.state.stations.find(s=>s.id===id);
 if(view==='trip'&&T.trip.data){const p=T.trip.data;return {start:p.inputs?.start,end:p.inputs?.end,stops:p.result.stops,geometry:p.geometry};}
 if(view==='edit'&&T.draft){const prev=T.preview.data,current=prev&&JSON.stringify(prev.order)===JSON.stringify(T.draft.stops)?prev:null;return {start:T.draft.start,end:T.draft.end||T.draft.start,stops:T.draft.stops.map(id=>({...(st(id)||{}),stationId:id,name:st(id)?.name||id})),geometry:current?.geometry||null};}
 return null;
}
function startOptions(ctx,current){
 const bases=T.settings?.planner?.bases||[],stations=ctx.state.stations.filter(s=>s.archiveStatus!=='INACTIVE'&&Number.isFinite(s.lat)).sort((a,b)=>a.name.localeCompare(b.name));
 const isBase=b=>current&&b.lat===current.lat&&b.lon===current.lon;
 return `<option value="">Choose a start…</option>${bases.map((b,i)=>`<option value="base:${i}" ${isBase(b)?'selected':''}>${esc(b.label)}</option>`).join('')}${current&&!bases.some(isBase)?`<option value="keep" selected>${esc(current.label)}</option>`:''}<option value="custom">Coordinates…</option><optgroup label="Start at a station">${stations.map(s=>`<option value="station:${esc(s.id)}">${esc(s.name)}</option>`).join('')}</optgroup>`;
}
function stopCard(ctx,id,i,n,res,editable){
 const s=ctx.state.stations.find(x=>x.id===id),stop=res?.stops?.find(x=>x.stationId===id),item=(ctx.state.ops?.queue||[]).find(q=>q.stations?.includes(id)&&['P1','P2','P3','P4','QC'].includes(q.effectiveTier)),tier=stop?.tier||item?.effectiveTier;
 const visit=T.draft?.visitMinutes?.[id]??stop?.serviceMinutes??'';
 return `<li class="stop"><span class="stop-n">${i+1}</span><div class="grow"><div class="stop-title"><button class="link-btn" data-open-station="${esc(id)}">${esc(s?.name||id)}</button>${tier&&tier!=='PM'?` <span class="tier-chip t-${esc(tier)}" title="${esc(PLAIN_TIER[tier])}">${GLYPH[tier]} ${esc(PLAIN_TIER[tier])}</span>`:''}</div>
  ${stop&&res.routed!==false?`<div class="stop-times"><span>Drive <strong>${dur(stop.driveMin)}</strong>${stop.distanceKm!=null?` · ${Math.round(stop.distanceKm*0.621371)} mi`:''}</span><span>Arrive <strong>${t(stop.arriveMs)}</strong>${stop.waitMin?` (wait ${stop.waitMin} min)`:''}</span><span>Visit <strong>${dur(stop.serviceMinutes)}</strong> until ${t(stop.serviceEndMs)}</span></div><div class="stop-wx wx-${esc(stop.weather.status)}">${esc(WX[stop.weather.status]||stop.weather.status)}${stop.weather.status!=='ok'&&stop.weather.reasons?.[0]?` · ${esc(stop.weather.reasons[0])}`:''}</div>`:''}
  ${editable?`<label class="visit">Visit <input type="number" min="5" max="480" step="5" value="${esc(visit)}" data-visit="${esc(id)}" aria-label="Visit minutes at ${esc(s?.name||id)}"> min</label>`:''}
  ${stop?.warnings?.length?`<details class="stop-notes"><summary>${stop.warnings.length} note${stop.warnings.length===1?'':'s'}</summary>${stop.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}</div>
  ${editable?`<div class="stop-ctl"><button class="icon-btn" data-move="${esc(id)}" data-dir="-1" ${i===0?'disabled':''} aria-label="Move ${esc(s?.name||id)} earlier">↑</button><button class="icon-btn" data-move="${esc(id)}" data-dir="1" ${i===n-1?'disabled':''} aria-label="Move ${esc(s?.name||id)} later">↓</button><button class="icon-btn" data-remove-stop="${esc(id)}" aria-label="Remove ${esc(s?.name||id)}">✕</button></div>`:''}</li>`;
}
// Field wording for routing states; technical setup lives in Settings.
export function plainRouting(message=''){
 if(/not configured|ORS_API_KEY secret put|Create an OpenRouteService/.test(message))return 'Road routing is not set up yet. An administrator can add it under Settings and connections.';
 if(/rejected/.test(message))return 'The road-routing key was rejected. An administrator needs to check it under Settings and connections.';
 if(/quota|rate limit|limit reached/i.test(message))return 'The road-routing limit was reached. Try again later; saved trips are unaffected.';
 return message?`Road routing is unavailable right now (${message.replace(/\.$/,'')}).`:'Road routing is unavailable right now.';
}
function summary(res,routing){
 if(!res)return '';
 tripDate=res.date||null;
 if(res.routed===false)return `<div class="routing-off"><strong>Road times not calculated.</strong> ${esc(plainRouting(res.blockers?.[0]))} Stops and visit times are kept in your order, and navigation links still open each leg in a maps app. Nothing is estimated from straight-line distance.</div>`;
 const tt=res.totals;if(!tt)return '';
 return `<dl class="trip-sum"><div><dt>Leave</dt><dd>${t(res.departMs)}</dd></div><div><dt>Back</dt><dd>${t(res.returnMs)}</dd></div><div><dt>Driving</dt><dd>${dur(tt.driveMin)}</dd></div><div><dt>Visits</dt><dd>${dur(tt.serviceMin)}</dd></div><div><dt>Breaks · buffers</dt><dd>${dur(tt.breakMin+tt.bufferMin)}</dd></div><div><dt>Road miles</dt><dd>${tt.distanceMi??'—'}</dd></div></dl><p class="footnote">Road times from ${esc(routing?.provider==='openrouteservice'?'OpenRouteService':routing?.provider||'the routing provider')}${routing?.matrixFetchedAt?`, fetched ${new Date(routing.matrixFetchedAt).toLocaleTimeString('en-US',{timeZone:'America/Detroit',hour:'numeric',minute:'2-digit'})}`:''}; typical speeds, no live traffic.${res.returnLeg?` Return drive ${dur(Math.round(res.returnLeg.driveSec/60))}.`:''}</p>`;
}
function notices(ctx,res,stops){
 const out=[];
 if((res?.warnings||[]).some(w=>w.startsWith('SYNTHETIC')))out.push('<li class="bad"><strong>Synthetic routing (test only):</strong> drive times and the dashed line are not real roads.</li>');
 for(const v of res?.violations||[])out.push(`<li class="bad">${esc(v.reason)}</li>`);
 for(const e of res?.exceptions||[])out.push(`<li class="warn">${esc(e.detail)}</li>`);
 const urgent=(ctx.state.ops?.queue||[]).filter(i=>['P1','P2'].includes(i.effectiveTier)&&!i.stations.some(s=>stops.includes(s)));
 if(urgent.length&&stops.length)out.push(`<li class="warn">Not in this trip: ${urgent.slice(0,4).map(i=>`${esc(PLAIN_TIER[i.effectiveTier])} — ${esc(i.title)}`).join('; ')}${urgent.length>4?` and ${urgent.length-4} more`:''}.</li>`);
 for(const w of (res?.warnings||[]).filter(w=>!/^(Manual order is infeasible|SYNTHETIC)/.test(w)))out.push(`<li>${esc(w)}</li>`);
 return out.length?`<ul class="notices">${out.join('')}</ul>`:'';
}
function editor(ctx){
 const d=draft(ctx.state.user),p=T.preview,res=p.data&&JSON.stringify(p.data.order)===JSON.stringify(d.stops)?p.data.result:null,stale=p.data&&!res;
 const custom=d.start?.custom;
 return `<div class="panel-head"><a class="link-btn" href="#/trips">← Trips</a><div class="grow"><h2>${d.planId?esc(d.title||'Edit trip'):'New trip'}</h2></div><button class="icon-btn" data-close-panel aria-label="Close">✕</button></div>
 <div class="panel-body" data-scroll>
  <form id="trip-form" class="trip-form"><div class="row3"><label>Date<input type="date" name="date" value="${esc(d.date)}" required></label><label>Leave<input type="time" name="departLocal" value="${esc(d.departLocal)}" required></label><label>Back by<input type="time" name="returnByLocal" value="${esc(d.returnByLocal)}" required></label></div>
  <label>Start and return<select name="start">${startOptions(ctx,d.start)}</select></label>
  <label class="${custom||d.start===null&&false?'':'hidden-field'}" id="custom-start-field">Coordinates (lat, lon)<input name="coords" placeholder="42.7369, -84.4839" value="${custom?esc(`${d.start.lat}, ${d.start.lon}`):''}"></label></form>
  ${!d.start?'<p class="warn-text">Choose a start to calculate road times.</p>':''}
  ${p.loading?'<p class="calc" role="status">Calculating road times…</p>':''}${p.error?`<p class="bad-text" role="alert">${esc(p.error)}</p>`:''}${stale&&!p.loading&&!p.error?'<p class="muted">Recalculating for your latest change…</p>':''}
  ${summary(res,p.data?.routing)}${notices(ctx,res,d.stops)}
  ${p.data?.geometryError?`<p class="warn-text">Road line unavailable: ${esc(p.data.geometryError)}</p>`:''}
  <h3 class="stops-h">Stops <span class="muted">(${d.stops.length})</span></h3>
  ${d.stops.length?`<ol class="stops">${d.stops.map((id,i)=>stopCard(ctx,id,i,d.stops.length,res,true)).join('')}</ol>`:'<p class="muted">Select a station on the map and choose <strong>Add to trip</strong>, or add the stations that need attention.</p>'}
  <div class="trip-actions"><button type="button" data-suggest>Add stations that need attention</button><button type="button" data-optimize ${d.stops.length<2?'disabled':''} title="Reorder for shorter driving without delaying urgent stops">Optimize order</button></div>
  <div class="trip-actions save">${ctx.canEdit?`<button class="primary" data-save-trip ${d.stops.length&&d.start?'':'disabled'}>${d.planId?'Save changes':'Save trip'}</button>`:''}${d.stops.length?'<button type="button" data-clear-trip class="quiet">Clear stops</button>':''}</div>
  <p class="footnote"><a href="#/trips/compare">Compare the next few days by priority and forecast</a></p>
 </div>`;
}
function list(ctx){
 if(!T.plans.data&&!T.plans.loading&&!T.plans.error){T.plans.loading=true;ctx.api('ops/plans').then(r=>{T.plans.data=r.plans;}).catch(e=>{T.plans.error=e.message;}).finally(()=>{T.plans.loading=false;ctx.repaint();});}
 const d=draft(ctx.state.user),plans=T.plans.data||[],upcoming=plans.filter(p=>['draft','accepted'].includes(p.status)),past=plans.filter(p=>!['draft','accepted'].includes(p.status));
 const card=p=>`<li><a class="trip-card" href="#/trip/${esc(p.id)}"><strong>${esc(p.title)}</strong><small>${esc(day(p.date))} · ${p.summary?.stops??0} stops${p.summary?.distanceMi?` · ${p.summary.distanceMi} mi`:''} · ${esc(p.status)}${p.outdated?.length?' · needs review':''}</small></a></li>`;
 return `<div class="panel-head"><div class="grow"><h2>Trips</h2></div><button class="icon-btn" data-close-panel aria-label="Close">✕</button></div><div class="panel-body" data-scroll>
  ${ctx.canEdit?`<a class="btn primary block" href="#/trips/new">${d.stops.length&&!d.planId?`Continue unsaved trip (${d.stops.length} stops)`:'New trip'}</a>`:''}
  ${T.plans.loading?'<p class="muted">Loading trips…</p>':T.plans.error?`<p class="bad-text">${esc(T.plans.error)}</p>`:''}
  <h3>Planned</h3>${upcoming.length?`<ul class="trip-list">${upcoming.map(card).join('')}</ul>`:'<p class="muted">No planned trips.</p>'}
  ${past.length?`<details class="fold"><summary>Completed and cancelled (${past.length})</summary><ul class="trip-list">${past.map(card).join('')}</ul></details>`:''}
  <p class="footnote"><a href="#/trips/compare">Compare the next few days by priority and forecast</a></p></div>`;
}
function tripView(ctx,id){
 if(T.trip.id!==id){T.trip={id,data:null,loading:false,error:''};}
 if(!T.trip.data&&!T.trip.loading&&!T.trip.error){T.trip.loading=true;ctx.api('ops/plans/'+id).then(p=>{if(T.trip.id===id)T.trip.data=p;}).catch(e=>{if(T.trip.id===id)T.trip.error=e.message;}).finally(()=>{if(T.trip.id===id){T.trip.loading=false;ctx.repaint();ctx.mapTrip?.(true);}});}
 const head=title=>`<div class="panel-head"><a class="link-btn" href="#/trips">← Trips</a><div class="grow"><h2>${esc(title)}</h2></div><button class="icon-btn" data-close-panel aria-label="Close">✕</button></div>`;
 if(!T.trip.data)return head('Trip')+`<div class="panel-body"><p class="${T.trip.error?'bad-text':'muted'}">${esc(T.trip.error||'Loading trip…')}</p></div>`;
 const p=T.trip.data,r=p.result,saved=!!getPacket(p.id),nav=p.navigation;
 return head(p.title)+`<div class="panel-body" data-scroll><p class="sub">${esc(day(p.date))} · ${esc(p.status)}${p.acceptOverride?` · accepted despite: ${esc(p.acceptOverride.reason)}`:''}</p>
  ${p.outdated?.length?`<div class="notice-box"><strong>Needs review.</strong> ${p.outdated.map(o=>esc(o.detail)).join(' ')} The saved itinerary was not changed.</div>`:''}
  ${summary(r,p.routing?.unavailable?null:{provider:p.routing?.provider,matrixFetchedAt:p.routing?.fetchedAt})}${notices(ctx,r,r.stops.map(s=>s.stationId))}
  <ol class="stops">${r.stops.map((s,i)=>stopCard(ctx,s.stationId,i,r.stops.length,r,false)).join('')}</ol>
  ${nav?`<h3>Navigation</h3><div class="nav-links">${nav.google.map(l=>`<a class="btn" target="_blank" rel="noreferrer" href="${esc(l.url)}">Google Maps · ${esc(l.label)}</a>`).join('')}<details><summary>Apple Maps, one leg at a time</summary>${nav.apple.map(l=>`<a class="btn small" target="_blank" rel="noreferrer" href="${esc(l.url)}">${esc(l.label)}</a>`).join('')}</details></div><p class="footnote">Links contain coordinates only. ${esc(nav.note)}</p>`:''}
  <h3>Field Notes</h3><div class="nav-links">${r.stops.map(s=>s.workItemIds?.length?`<a class="btn small" href="/field-notes/?work=${encodeURIComponent(s.workItemIds[0])}">${esc(s.name)}</a>`:'').join('')||'<p class="muted">Create a work item on an issue to start a prefilled Field Notes visit.</p>'}</div>
  <div class="trip-actions">${ctx.canEdit&&p.status==='draft'?`<button data-edit-trip>Edit stops</button><button class="primary" data-trip-status="accepted">Accept</button>`:''}${ctx.canEdit&&p.status==='accepted'?'<button class="primary" data-trip-status="completed">Record completion</button>':''}${ctx.canEdit&&['draft','accepted'].includes(p.status)?'<button data-trip-status="cancelled" class="quiet">Cancel trip</button>':''}${ctx.canEdit?'<button data-copy-trip class="quiet">Copy</button>':''}</div>
  <div class="trip-actions"><button data-print-trip>Print</button><button data-export-trip="csv" class="quiet">CSV</button><button data-export-trip="json" class="quiet">JSON</button>${saved?'<button data-remove-packet class="quiet">Remove offline copy</button>':'<button data-save-packet class="quiet">Save for offline</button>'}</div>
  ${p.routing?.attribution?`<p class="footnote">${esc(p.routing.attribution)}</p>`:''}
 </div>`;
}
export function tripsPanel(ctx,route){
 loadSettings(ctx);draft(ctx.state.user);tripDate=null;
 if(route.view==='edit'){schedule(ctx);return editor(ctx);}
 if(route.view==='trip')return tripView(ctx,route.id);
 return list(ctx);
}
function printTrip(p){
 const w=document.querySelector('#print-root');if(!w)return;tripDate=p.result.date||p.date||null;
 w.innerHTML=`<h1>${esc(p.title)}</h1><p>${esc(day(p.date))} · leave ${t(p.result.departMs)} · back ${t(p.result.returnMs)} · ${esc(p.result.routed===false?'road times not calculated':`${p.result.totals?.distanceMi} road miles`)}</p><table><thead><tr><th>#</th><th>Station</th><th>Arrive</th><th>Visit</th><th>Drive</th><th>Tasks</th></tr></thead><tbody>${p.result.stops.map((s,i)=>`<tr><td>${i+1}</td><td>${esc(s.name)}<br><small>${esc(s.stationId)} · ${esc(PLAIN_TIER[s.tier]||'')}</small></td><td>${t(s.arriveMs)}</td><td>${dur(s.serviceMinutes)}</td><td>${dur(s.driveMin)}</td><td>${s.tasks.slice(0,5).map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table><p>Printed ${new Date().toLocaleString('en-US',{timeZone:'America/Detroit'})}. Drive times use typical speeds; confirm weather before leaving.</p>`;
 document.body.classList.add('printing-trip');window.print();setTimeout(()=>document.body.classList.remove('printing-trip'),500);
}
export function bindTrips(root,ctx){
 const d=T.draft,form=root.querySelector('#trip-form');
 const changed=(opts)=>{saveDraft();ctx.repaint();schedule(ctx,opts);ctx.mapTrip?.();};
 if(form){
  form.onchange=e=>{const f=new FormData(form),name=e.target.name;
   if(['date','departLocal','returnByLocal'].includes(name))d[name]=f.get(name);
   if(name==='start'){const v=f.get('start');if(v.startsWith('base:'))d.start=T.settings.planner.bases[Number(v.slice(5))];else if(v.startsWith('station:')){const s=ctx.state.stations.find(x=>x.id===v.slice(8));d.start={label:s.name,lat:s.lat,lon:s.lon};}else if(v==='custom'){root.querySelector('#custom-start-field').classList.remove('hidden-field');return;}}
   if(name==='coords'){const [lat,lon]=String(f.get('coords')).split(',').map(Number);if(Number.isFinite(lat)&&Number.isFinite(lon))d.start={label:`${lat.toFixed(4)}, ${lon.toFixed(4)}`,lat,lon,custom:true};else return ctx.toast('Enter coordinates as "latitude, longitude".');}
   changed();};
 }
 root.querySelectorAll('[data-move]').forEach(b=>b.onclick=()=>{const i=d.stops.indexOf(b.dataset.move),j=i+Number(b.dataset.dir);if(j<0||j>=d.stops.length)return;[d.stops[i],d.stops[j]]=[d.stops[j],d.stops[i]];changed();});
 root.querySelectorAll('[data-remove-stop]').forEach(b=>b.onclick=()=>{d.stops=d.stops.filter(s=>s!==b.dataset.removeStop);delete d.visitMinutes[b.dataset.removeStop];changed();ctx.markers?.();});
 root.querySelectorAll('[data-visit]').forEach(i=>i.onchange=()=>{const v=Number(i.value);if(Number.isInteger(v)&&v>=5&&v<=480)d.visitMinutes[i.dataset.visit]=v;else delete d.visitMinutes[i.dataset.visit];changed();});
 const sug=root.querySelector('[data-suggest]');if(sug)sug.onclick=()=>{const add=(ctx.state.ops?.queue||[]).filter(i=>['P1','P2','P3','P4'].includes(i.effectiveTier)).flatMap(i=>i.stations).filter((s,k,a)=>a.indexOf(s)===k&&!d.stops.includes(s)).slice(0,Math.max(0,8-d.stops.length));if(!add.length)return ctx.toast('No more stations need attention.');d.stops=[...d.stops,...add];changed();ctx.markers?.();};
 const opt=root.querySelector('[data-optimize]');if(opt)opt.onclick=()=>{T.preview.key='';schedule(ctx,{optimize:true,immediate:true});};
 const clr=root.querySelector('[data-clear-trip]');if(clr)clr.onclick=()=>{d.stops=[];d.visitMinutes={};changed();ctx.markers?.();};
 root.querySelectorAll('[data-open-station]').forEach(b=>b.onclick=()=>ctx.openStation(b.dataset.openStation));
 const save=root.querySelector('[data-save-trip]');if(save)save.onclick=async()=>{save.disabled=true;try{
  const body={inputs:{...inputsOf(d),tiers:[],required:d.stops,includeDuplicates:d.stops},date:d.date,order:d.stops,title:d.title||`Trip · ${day(d.date)}`};
  const saved=d.planId?await ctx.api('ops/plans/'+d.planId,{method:'PATCH',body:JSON.stringify({revision:d.revision,order:d.stops,inputs:body.inputs})}):await ctx.api('ops/plans',{method:'POST',body:JSON.stringify(body)});
  T.draft=newDraft();saveDraft();T.plans.data=null;T.trip={id:null,data:null,loading:false,error:''};ctx.toast('Trip saved.');ctx.go('#/trip/'+saved.id);ctx.markers?.();
 }catch(e){ctx.toast(e.message);save.disabled=false;}};
 const p=T.trip.data;
 const edit=root.querySelector('[data-edit-trip]');if(edit&&p)edit.onclick=()=>{T.draft={...newDraft(),planId:p.id,revision:p.revision,title:p.title,date:p.date,start:p.inputs.start,end:p.inputs.end,departLocal:p.inputs.departLocal,returnByLocal:p.inputs.returnByLocal,maxWorkdayMinutes:p.inputs.maxWorkdayMinutes,bufferMinutes:p.inputs.bufferMinutes,breaks:p.inputs.breaks,crew:p.inputs.crew,stops:p.result.stops.map(s=>s.stationId),visitMinutes:p.inputs.visitMinutes||{}};saveDraft();T.preview.key='';ctx.go('#/trips/new');};
 root.querySelectorAll('[data-trip-status]').forEach(b=>b.onclick=async()=>{const status=b.dataset.tripStatus,body={revision:p.revision,status};
  if(status==='completed'){const n=prompt('What was visited and done? Telemetry recovery is tracked separately.');if(!n)return;body.completionNote=n;}
  if(status==='accepted'&&!p.result.feasible){const n=prompt(`This trip breaks a constraint:\n${(p.result.violations||[]).map(v=>v.reason).join('\n')||p.result.blockers?.join('\n')||'Road times were not calculated.'}\n\nWhy accept it anyway?`);if(!n)return;body.overrideReason=n;}
  try{await ctx.api('ops/plans/'+p.id,{method:'PATCH',body:JSON.stringify(body)});T.trip.data=null;T.plans.data=null;ctx.toast('Trip '+status+'.');ctx.repaint();}catch(e){ctx.toast(e.message);}});
 const copy=root.querySelector('[data-copy-trip]');if(copy)copy.onclick=async()=>{try{const c=await ctx.api('ops/plans/'+p.id+'/copy',{method:'POST',body:'{}'});T.plans.data=null;ctx.go('#/trip/'+c.id);}catch(e){ctx.toast(e.message);}};
 root.querySelectorAll('[data-export-trip]').forEach(b=>b.onclick=async()=>{try{await ctx.downloadFromAPI(`ops/plans/${p.id}/export?format=${b.dataset.exportTrip}`,`trip-${p.date}.${b.dataset.exportTrip}`);}catch(e){ctx.toast(e.message);}});
 const pr=root.querySelector('[data-print-trip]');if(pr)pr.onclick=()=>printTrip(p);
 const sp=root.querySelector('[data-save-packet]');if(sp)sp.onclick=async()=>{try{const notes={};for(const s of p.result.stops){try{notes[s.stationId]=await ctx.api('ops/notes/'+encodeURIComponent(s.stationId));}catch{}}savePacket(p,notes,ctx.state.user);ctx.toast('Saved on this device for offline reading. Gate codes are not stored.');ctx.repaint();}catch(e){ctx.toast(e.message);}};
 const rp=root.querySelector('[data-remove-packet]');if(rp)rp.onclick=()=>{removePacket(p.id);ctx.toast('Offline copy removed from this device.');ctx.repaint();};
}
export {navigationLinks};
