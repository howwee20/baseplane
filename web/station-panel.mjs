// Station panel on the map: readings first, evidence and diagnostics on demand.
import {stationReadings,reading,cardinal,stationHealth,PLAIN_TIER,MEASURES,formatValue} from './lib/readings.mjs';
import {formatDuration} from './lib/fleet/priority.mjs';
import {modelLinks} from './lib/model-links.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>{const t=Date.parse(v||'');return Number.isFinite(t)?new Date(t).toLocaleTimeString('en-US',{timeZone:'America/Detroit',hour:'numeric',minute:'2-digit'}):'—';};
const when=v=>{const t=Date.parse(v||'');if(!Number.isFinite(t))return '—';const d=new Date(t),today=new Date().toLocaleDateString('en-US',{timeZone:'America/Detroit'});return d.toLocaleDateString('en-US',{timeZone:'America/Detroit'})===today?time(v):d.toLocaleString('en-US',{timeZone:'America/Detroit',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
const ago=m=>m===null||m===undefined?'':m<1?'just now':m<60?`${m} min ago`:m<2880?`${Math.floor(m/60)} h ${m%60} min ago`:`${Math.floor(m/1440)} days ago`;
const HISTORY_VARS=['air_temp','relative_humidity','wind_speed','precip_accum_one_hour','solar_radiation','soil_temp','volt'];
let S={id:null,history:null,historyLoading:false,historyError:'',historyVar:'air_temp',detail:null,detailLoading:false,detailError:'',open:{},scroll:0,ticket:0};
export function resetStationPanel(){S={id:null,history:null,historyLoading:false,historyError:'',historyVar:'air_temp',detail:null,detailLoading:false,detailError:'',open:{},scroll:0,ticket:0};}
export const refreshStationDetail=()=>{S.detail=null;S.detailError='';};

function qualityNotes(s,h,health,readings){
 const notes=[];
 if(health.code==='out'){const last=Date.parse(s.last||'');notes.push({cls:'bad',text:`Not reporting${Number.isFinite(last)?` since ${when(s.last)} (${formatDuration(Math.round((Date.now()-last)/60000))})`:''}.${health.tier?` ${PLAIN_TIER[health.tier]} · ${health.confirmed?'confirmed':'suspected, awaiting confirmation'}.`:''}`});}
 if(h?.issueGroups?.length)notes.push({cls:'warn',text:`Missing or stale: ${h.issueGroups.map(g=>g.label).join('; ')}${h.issueGroups.some(g=>g.provisional)?' (instrument grouping provisional)':''}.`});
 if(health.code==='delayed')notes.push({cls:'warn',text:`Newest reading is ${h?.ageMinutes??s.ageMinutes} minutes old.`});
 const flagged=readings.filter(r=>r.flagged);if(flagged.length)notes.push({cls:'qc',text:`QC flag on ${flagged.map(r=>r.label.toLowerCase()).join(', ')}: a check to review, not a confirmed equipment fault.`});
 if(s.carriedForward)notes.push({cls:'warn',text:`Missing from the latest provider response; values carried forward from ${when(s.carriedForward)}.`});
 if(!notes.length&&health.code==='ok')notes.push({cls:'ok',text:'Reporting all expected sensors.'});
 return notes;
}
function readingRow(r,extra=''){
 const state=r.flagged?'<span class="chip qc">QC flag</span>':r.future?'<span class="chip bad">Clock ahead</span>':r.stale?'<span class="chip old">Old</span>':'';
 return `<tr class="${r.flagged?'flagged':r.stale?'stale':''}"><th scope="row">${esc(r.label)}</th><td><strong class="num">${r.value?esc(r.value.text):'—'}</strong> <span class="unit">${esc(r.value?.unit||'')}</span>${extra}${r.value?.metric?`<small>${esc(r.value.metric)}</small>`:''}</td><td>${esc(when(r.time))}<small>${esc(ago(r.ageMinutes))}</small></td><td>${state}</td></tr>`;
}
function readingsTable(s,health,readings){
 const by=Object.fromEntries(readings.map(r=>[r.variable,r])),rows=[];
 for(const v of ['air_temp','dew_point_temperature','relative_humidity'])if(by[v])rows.push(readingRow(by[v]));
 if(by.wind_speed){const d=by.wind_direction,g=by.wind_gust;rows.push(readingRow(by.wind_speed,`${d?.value&&!d.flagged?` <span class="dir">${esc(cardinal(d.raw))}</span>`:''}${g?.value&&!g.flagged?` <small>gust ${esc(g.value.text)} ${esc(g.value.unit)}</small>`:''}`));}
 for(const v of ['precip_accum_one_hour','solar_radiation','soil_temp','soil_moisture','volt'])if(by[v])rows.push(readingRow(by[v]));
 if(!rows.length)return '<p class="muted">No readings in the latest snapshot.</p>';
 return `<table class="readings"><caption class="sr-only">Latest readings</caption><tbody>${rows.join('')}</tbody></table>`;
}
function chart(data,variable){
 const st=data?.STATION?.[0],obs=st?.OBSERVATIONS||{},key=Object.keys(obs).filter(k=>k.startsWith(variable+'_set_')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))[0];
 if(!key)return '<p class="muted">No history for this measurement in the selected window.</p>';
 const unit=data.UNITS?.[variable],qc=st.QC?.[key]||[],pts=(obs.date_time||[]).map((t,i)=>({t:Date.parse(t),raw:obs[key][i],flag:Array.isArray(qc[i])?qc[i].length>0:!!qc[i]})).filter(p=>Number.isFinite(p.t)&&typeof p.raw==='number'&&Number.isFinite(p.raw)).map(p=>({...p,v:formatValue(variable,p.raw,unit)?.converted})).filter(p=>Number.isFinite(p.v));
 const good=pts.filter(p=>!p.flag);if(good.length<2)return '<p class="muted">Not enough unflagged readings to chart.</p>';
 const W=420,H=150,L=36,R=8,T=10,B=22,t0=good[0].t,t1=good.at(-1).t,lo=Math.min(...good.map(p=>p.v)),hi=Math.max(...good.map(p=>p.v)),pad=(hi-lo)*0.1||1;
 const x=t=>L+(t-t0)/(t1-t0||1)*(W-L-R),y=v=>T+(1-(v-lo+pad)/(hi-lo+2*pad))*(H-T-B);
 let d='',prev=null;for(const p of good){d+=(prev&&p.t-prev.t<=2.5*3600000?'L':'M')+x(p.t).toFixed(1)+' '+y(p.v).toFixed(1);prev=p;}
 const m=MEASURES[variable],u=formatValue(variable,0,unit)?.unit||unit||'';
 return `<svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m?.label||variable)} over the selected window, ${good.length} readings"><line x1="${L}" x2="${W-R}" y1="${y(hi)}" y2="${y(hi)}" class="grid"/><line x1="${L}" x2="${W-R}" y1="${y(lo)}" y2="${y(lo)}" class="grid"/><text x="${L-4}" y="${y(hi)+3}" text-anchor="end">${Math.round(hi*10)/10}</text><text x="${L-4}" y="${y(lo)+3}" text-anchor="end">${Math.round(lo*10)/10}</text><path d="${d}" class="line"/>${pts.filter(p=>p.flag).map(p=>`<circle cx="${x(Math.min(Math.max(p.t,t0),t1))}" cy="${H-B+6}" r="2.5" class="flag"><title>QC-flagged reading ${esc(when(new Date(p.t).toISOString()))} (excluded)</title></circle>`).join('')}<text x="${L}" y="${H-4}">${esc(when(new Date(t0).toISOString()))}</text><text x="${W-R}" y="${H-4}" text-anchor="end">${esc(when(new Date(t1).toISOString()))}</text><text x="${W-R}" y="${T+2}" text-anchor="end" class="u">${esc(u)}</text></svg>${pts.some(p=>p.flag)?'<p class="footnote">Dots under the axis mark QC-flagged readings, which are left out of the line.</p>':''}`;
}
export function stationPanel(ctx){
 const {state,stationId,trip}=ctx,s=state.stations.find(x=>x.id===stationId);
 if(S.id!==stationId){resetStationPanel();S.id=stationId;}
 if(!s)return `<div class="panel-head"><h2>Station not found</h2><button class="icon-btn" data-close-panel aria-label="Close">✕</button></div><p class="muted">This station is not in the current network snapshot.</p>`;
 const h=state.ops?.health?.[s.id],health=stationHealth(s,state.ops),now=Date.now();
 const readings=stationReadings(s,{now,staleMinutes:state.connection?.stale||180,missing:h?.issueKeys||[]});
 const notes=qualityNotes(s,h,health,readings),inTrip=trip?.has(s.id),items=(state.ops?.queue||[]).filter(i=>i.stations?.includes(s.id));
 if(!S.history&&!S.historyLoading&&!S.historyError)queueMicrotask(()=>loadHistory(ctx));
 const vars=S.history?HISTORY_VARS.filter(v=>Object.keys(S.history.STATION?.[0]?.OBSERVATIONS||{}).some(k=>k.startsWith(v+'_set_'))):[];
 const place=[s.state,Number.isFinite(s.lat)?`${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}`:'',Number.isFinite(s.elevationFt)?`${Math.round(s.elevationFt)} ft`:''].filter(Boolean).join(' · ');
 return `<div class="panel-head">${ctx.back?`<button class="link-btn" data-panel-back>${esc(ctx.back.label)}</button>`:''}<div class="grow"><h2>${esc(s.name)}</h2><p class="sub"><span class="mono">${esc(s.id)}</span> · ${esc(place)}</p></div><button class="icon-btn" data-close-panel aria-label="Close station">✕</button></div>
 <div class="panel-body" data-scroll>
  <ul class="quality">${notes.map(n=>`<li class="${n.cls}">${esc(n.text)}</li>`).join('')}</ul>
  ${readingsTable(s,health,readings)}
  <p class="footnote">Observation times are shown per reading. Network fetched ${esc(when(state.fetchedAt))}.</p>
  <div class="panel-actions">${ctx.canEdit?`<button class="${inTrip?'':'primary'}" data-trip-toggle="${esc(s.id)}">${inTrip?'Remove from trip':'Add to trip'}</button>`:''}${items.filter(i=>i.scope==='station'||i.scope==='group').slice(0,1).map(i=>`<a class="btn" href="#/incident/${esc(i.scope==='group'?i.id:i.id)}">Issue details</a>`).join('')}<a class="btn quiet" href="#/station/${encodeURIComponent(s.id)}/details">Full station record</a></div>
  ${modelSection(s.id)}
  <section class="fold"><div class="fold-head"><h3>History</h3>${vars.length?`<label class="sr-only" for="hist-var">Measurement</label><select id="hist-var">${vars.map(v=>`<option value="${v}" ${v===S.historyVar?'selected':''}>${esc(MEASURES[v]?.label||v)}</option>`).join('')}</select>`:''}</div>${S.historyLoading?'<p class="muted">Loading the past 24 hours…</p>':S.historyError?`<p class="muted">History unavailable: ${esc(S.historyError)} <button class="link-btn" data-retry-history>Retry</button></p>`:S.history?chart(S.history,vars.includes(S.historyVar)?S.historyVar:vars[0]):''}</section>
  <details class="fold" data-fold="notes" ${S.open.notes?'open':''}><summary>Notes, issues and visits</summary>${S.open.notes?notesSection(ctx,s,items):''}</details>
  <details class="fold" data-fold="details" ${S.open.details?'open':''}><summary>Sensors and nearby comparison</summary>${S.open.details?detailSection(ctx,s,h):''}</details>
 </div>`;
}
function ensureDetail(ctx){if(!S.detail&&!S.detailLoading&&!S.detailError)queueMicrotask(()=>loadDetail(ctx));}
function notesSection(ctx,s,items){
 ensureDetail(ctx);
 const records=(ctx.state.records||[]).filter(r=>r.station===s.id),d=S.detail;
 const issues=d?d.incidents:[];
 return `<div class="fold-body">${S.detailLoading&&!d?'<p class="muted">Loading…</p>':S.detailError?`<p class="muted">${esc(S.detailError)}</p>`:''}
  ${d?`<h4>Access</h4><p>${esc(d.notes?.accessNotes||'No access notes recorded.')}</p>${d.notes?.gateCodeRestricted?'<p class="footnote">Gate code restricted to editors.</p>':d.notes?.gateCode?'<p class="footnote">Gate code on file (shown in the full station record).</p>':''}`:''}
  <h4>Issues</h4>${issues.length?`<ul class="plain-list">${issues.slice(0,6).map(i=>`<li><a href="#/incident/${esc(i.id)}">${esc(PLAIN_TIER[i.tierOverride?.tier||i.tier]||i.tier)}</a> · ${esc(i.state==='resolved'?'resolved '+when(i.resolvedAt):i.state)}<small>${esc((i.body?.reasons||[])[0]||'')}</small></li>`).join('')}</ul>`:d?'<p class="muted">No issues recorded.</p>':''}
  <h4>Work and investigations</h4>${(d?.work||[]).length||records.length?`<ul class="plain-list">${(d?.work||[]).slice(0,5).map(w=>`<li>${esc(w.title)} · ${esc(w.status.replace('_',' '))}${w.workPerformed?`<small>Done: ${esc(w.workPerformed.summary)}</small>`:''}</li>`).join('')}${records.slice(0,5).map(r=>`<li><button class="link-btn" data-record="${esc(r.id)}">${esc(r.title)}</button> · ${esc(r.status)}</li>`).join('')}</ul>`:'<p class="muted">None recorded.</p>'}
  <p><a href="#/records/visits">Field Notes visits</a> · <a href="/field-notes/">Open notebook</a></p></div>`;
}
function detailSection(ctx,s,h){
 ensureDetail(ctx);const d=S.detail;
 if(!d)return `<div class="fold-body">${S.detailError?esc(S.detailError):'<p class="muted">Loading…</p>'}</div>`;
 const ch=d.health.channels,bad=ch.filter(c=>c.expected&&!['ok','qc-suspect'].includes(c.state));
 const cov=d.coverage.rows.filter(r=>r.status!=='no-target-sensor');
 return `<div class="fold-body"><h4>Expected sensors</h4><p>${d.health.reportingCount} of ${d.health.expectedCount} expected channels reporting.</p>${bad.length?`<ul class="plain-list">${bad.map(c=>`<li><span class="mono">${esc(c.channel)}</span> · ${esc(c.state.replace('-',' '))}<small>${esc(c.note)}</small></li>`).join('')}</ul>`:''}
  <h4>Nearby stations</h4><ul class="plain-list">${cov.map(r=>`<li>${esc(r.label)}: ${r.status==='available'?(r.inBand===false?`<strong>outside</strong> the nearby range (${r.references.length} stations)`:r.inBand?`within the nearby range (${r.references.length} stations)`:`${r.references.length} reference stations; target reading unavailable`):esc(r.reason)}</li>`).join('')}</ul>
  <p class="footnote">Nearby comparisons are evidence for review, not certified calibration. <a href="#/station/${encodeURIComponent(s.id)}/details">Full diagnostics</a></p></div>`;
}
async function loadHistory(ctx){const id=S.id,t=++S.ticket;S.historyLoading=true;try{const d=await ctx.api('history?station='+encodeURIComponent(id)+'&hours=24');if(S.id!==id||t!==S.ticket)return;S.history=d;S.historyError='';}catch(e){if(S.id===id&&t===S.ticket)S.historyError=e.message;}finally{if(S.id===id&&t===S.ticket){S.historyLoading=false;ctx.repaint();}}}
async function loadDetail(ctx){const id=S.id;S.detailLoading=true;try{const d=await ctx.api('ops/stations/'+encodeURIComponent(id));if(S.id!==id)return;S.detail=d;S.detailError='';}catch(e){if(S.id===id)S.detailError=e.message;}finally{if(S.id===id){S.detailLoading=false;ctx.repaint();}}}
export function bindStationPanel(root,ctx){
 const body=root.querySelector('[data-scroll]');if(body){body.scrollTop=S.scroll;body.onscroll=()=>{S.scroll=body.scrollTop;};}
 root.querySelectorAll('[data-fold]').forEach(d=>d.ontoggle=()=>{const was=!!S.open[d.dataset.fold];S.open[d.dataset.fold]=d.open;if(d.open&&!was)ctx.repaint();});
 const v=root.querySelector('#hist-var');if(v)v.onchange=()=>{S.historyVar=v.value;ctx.repaint();};
 const retry=root.querySelector('[data-retry-history]');if(retry)retry.onclick=()=>{S.historyError='';S.history=null;ctx.repaint();};
}
// Shown only for stations whose Enviroweather mapping has been verified (see lib/model-links.mjs); empty by default.
function modelSection(id){const links=modelLinks(id);return links.length?`<section class="fold"><h3>Models</h3><div class="nav-links">${links.map(l=>`<a class="btn small" target="_blank" rel="noreferrer" href="${esc(l.url)}">${esc(l.label)}</a>`).join('')}</div></section>`:'';}
