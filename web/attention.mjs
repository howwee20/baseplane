// "Needs attention": the server's priority-ordered queue in plain language. Order is never re-sorted here:
// groups of stations out, then single stations out, then several sensors, then one sensor.
import {PLAIN_TIER} from './lib/readings.mjs';
import {formatDuration} from './lib/fleet/priority.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=v=>{const t=Date.parse(v||'');return Number.isFinite(t)?new Date(t).toLocaleString('en-US',{timeZone:'America/Detroit',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';};
const GLYPH={P1:'✕✕',P2:'✕',P3:'▲▲',P4:'▲',QC:'?',PM:'●'};
const SECTION={P1:'Groups of stations out',P2:'Stations out',P3:'Several sensors down',P4:'One sensor down'};
let A={tab:'issues',alerts:null,loading:false,error:''};
export function resetAttention(){A={tab:'issues',alerts:null,loading:false,error:''};}
export const attentionCount=ops=>(ops?.queue||[]).filter(i=>['P1','P2','P3','P4'].includes(i.effectiveTier)).length;
// Short operator wording; full evidence stays on the issue page.
export function plainReason(i){
 if(i.scope==='group')return `${i.stations.length} stations not reporting${i.durationMinutes!=null?` · ${formatDuration(i.durationMinutes)}`:''}`;
 if(i.kind==='outage')return `Not reporting${i.durationMinutes!=null?` for ${formatDuration(i.durationMinutes)}`:''}${i.lastGood?` · last reading ${when(i.lastGood)}`:''}`;
 if(i.sensorGroups?.length)return `Missing: ${i.sensorGroups.map(g=>g.label.replace(/ · .*$/,'')).join(', ')}`;
 if(i.scope==='review')return (i.reasons[0]||'QC flag to review').replace(/; review against references\.?$/,'');
 return i.reasons[0]||'';
}
function row(i,ops){
 const names=i.scope==='group'?i.stations.map(id=>ops.health?.[id]?.name||id).join(', '):i.title;
 return `<li><button class="att-item" data-attention="${esc(i.id)}" data-stations="${esc(i.stations.join(','))}"><span class="att-glyph t-${esc(i.effectiveTier)}" aria-hidden="true">${GLYPH[i.effectiveTier]||'•'}</span><span class="grow"><strong>${esc(names)}</strong><small>${esc(plainReason(i))}</small><small class="meta">${i.confidence==='confirmed'?'Confirmed':'Suspected · waiting for confirmation'}${i.assignee?` · ${esc(i.assignee)}`:''}${i.overdue?' · past due':''}${i.plannedIn?` · on trip ${esc(i.plannedIn.date)}`:''}${i.tierOverride?' · urgency set by team':''}</small></span></button></li>`;
}
export function attentionPanel(ctx){
 const ops=ctx.state.ops;if(!ops)return '<div class="panel-head"><h2>Needs attention</h2><button class="icon-btn" data-close-panel aria-label="Close">✕</button></div><p class="muted">Operations data is unavailable.</p>';
 const tab=ctx.tab||A.tab;A.tab=tab;
 const issues=ops.queue.filter(i=>['P1','P2','P3','P4'].includes(i.effectiveTier)),qc=ops.queue.filter(i=>i.effectiveTier==='QC');
 const feed=ops.feed.status!=='ok'?`<p class="feed ${ops.feed.status==='failed'?'bad':'warn'}">${ops.feed.status==='failed'?'Weather data feed problem':'Provider data incomplete or old'}: ${esc((ops.feed.reasons||[]).join(' ')||`network data ${ops.feed.cacheAgeMinutes} min old`)} Outages are not confirmed from missing feed data.</p>`:'';
 let body='';
 if(tab==='issues'){
  if(!issues.length)body='<p class="muted pad">No station or sensor problems are open.</p>';
  else{let last=null;body='<ol class="att-list">';for(const i of issues){if(i.effectiveTier!==last){body+=`<li class="att-section">${esc(SECTION[i.effectiveTier])}</li>`;last=i.effectiveTier;}body+=row(i,ops);}body+='</ol>';}
  body+=`<p class="footnote pad">Listed by urgency: groups out, then single stations out, then several sensors, then one sensor. Within a group, the longest-running comes first. ${esc(ops.detection.note.split('. ').slice(-1)[0]||'')}</p>`;
 }else if(tab==='qc'){
  body=qc.length?`<ol class="att-list">${qc.map(i=>row(i,ops)).join('')}</ol>`:'<p class="muted pad">No quality-check flags to review.</p>';
  body+='<p class="footnote pad">Quality-check flags are evidence for review, not confirmed equipment failures. <a href="#/records/references">Compare stations with nearby readings</a></p>';
 }else{
  if(!A.alerts&&!A.loading&&!A.error)queueMicrotask(()=>loadAlerts(ctx));
  const list=A.alerts||[];
  body=A.loading&&!A.alerts?'<p class="muted pad">Loading…</p>':A.error?`<p class="muted pad">${esc(A.error)}</p>`:list.length?`<ol class="att-list">${list.map(a=>`<li><div class="att-item static"><span class="att-glyph t-${esc(a.tier||'')}" aria-hidden="true">${GLYPH[a.tier]||'!'}</span><span class="grow"><strong>${esc(a.title.replace(/^(?:P[1-4]|QC|PM) · /,''))}</strong><small>${esc(when(a.created))} · ${esc({new:'New',escalated:'More urgent',expanded:'Group grew',recovered:'Recovered',feed:'Feed problem','feed-recovered':'Feed recovered',summary:'More updates'}[a.kind]||a.kind)}</small></span>${a.incidentId?`<a class="btn small" href="#/incident/${esc(a.incidentId)}">Open</a>`:''}${ctx.canEdit&&!a.acknowledgedAt?`<button class="small quiet" data-ack="${esc(a.id)}">Seen</button>`:''}</div></li>`).join('')}</ol>`:'<p class="muted pad">No unacknowledged changes.</p>';
  body+='<p class="footnote pad">Marking a change as seen does not acknowledge or resolve the issue. Alerts are shown here only; email and Teams delivery are not set up.</p>';
 }
 return `<div class="panel-head"><div class="grow"><h2>Needs attention</h2><p class="sub">Network fetched ${esc(when(ops.feed.networkFetchedAt))}</p></div><button class="icon-btn" data-close-panel aria-label="Close">✕</button></div>${feed}<div class="tabs" role="tablist">${[['issues',`Problems (${issues.length})`],['qc',`Quality checks (${qc.length})`],['changes',`Recent changes${ops.openAlerts?` (${ops.openAlerts})`:''}`]].map(([k,l])=>`<a role="tab" aria-selected="${tab===k}" class="${tab===k?'on':''}" href="#/attention${k==='issues'?'':'/'+k}">${l}</a>`).join('')}</div><div class="panel-body">${body}</div>`;
}
async function loadAlerts(ctx){A.loading=true;try{A.alerts=(await ctx.api('ops/alerts')).alerts;A.error='';}catch(e){A.error=e.message;}finally{A.loading=false;ctx.repaint();}}
export function bindAttention(root,ctx){
 root.querySelectorAll('[data-attention]').forEach(b=>b.onclick=()=>{const ids=b.dataset.stations.split(',').filter(Boolean);ctx.openFromAttention(b.dataset.attention,ids);});
 root.querySelectorAll('[data-ack]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await ctx.api('ops/alerts/ack',{method:'POST',body:JSON.stringify({ids:[b.dataset.ack]})});A.alerts=null;ctx.reload();}catch(e){ctx.toast(e.message);b.disabled=false;}});
}
