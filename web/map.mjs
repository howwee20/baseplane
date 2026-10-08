// The persistent home map: one Leaflet instance for the whole session. Markers, layers and the trip route update in
// place; nothing here re-creates the map, so position, zoom and layer choices survive refreshes and panel changes.
import {MAP_VARIABLES,MEASURES,SCALES,markerReading,scaleColor,stationHealth} from './lib/readings.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const MICHIGAN=[[41.55,-90.55],[47.65,-82.15]];
const RADAR_BOUNDS=[[40,-93.5],[49.5,-78.5]];
const RADAR_SOURCE='NWS NEXRAD base reflectivity composite (N0Q) via Iowa Environmental Mesonet';
const store={get(k,f){try{return JSON.parse((k.startsWith('view')?sessionStorage:localStorage).getItem('fleet-map-'+k))??f;}catch{return f;}},set(k,v){try{(k.startsWith('view')?sessionStorage:localStorage).setItem('fleet-map-'+k,JSON.stringify(v));}catch{}}};
const time=ms=>Number.isFinite(ms)?new Date(ms).toLocaleTimeString('en-US',{timeZone:'America/Detroit',hour:'numeric',minute:'2-digit'}):'—';
let map=null,el=null,markers=new Map(),stationsById=new Map(),selected=null,handlers={},prefs=null,routeLayer=null,radar=null,lastOps=null,legendEl=null,statusEl=null;
const GLYPH={out:'✕',sensor:'▲',qc:'?',delayed:'◷',maintenance:'Ⅱ',unknown:'·',inactive:'',ok:''};

export function initMap(container,opts={}){
 if(map)return map;
 el=container;handlers=opts;prefs={variable:'air_temp',radar:true,opacity:0.55,...store.get('prefs',{})};
 if(!MAP_VARIABLES.includes(prefs.variable))prefs.variable='air_temp';
 map=L.map(container,{zoomSnap:0.25,minZoom:5,maxZoom:13,maxBounds:[[34,-104],[56,-66]],maxBoundsViscosity:0.6,worldCopyJump:false,zoomControl:false,attributionControl:true});
 L.control.zoom({position:'topleft'}).addTo(map);
 for(const [name,z] of [['outline',150],['base',200],['radar',350],['route',480]]){const p=map.createPane(name);p.style.zIndex=z;if(name==='radar')p.style.pointerEvents='none';}
 // Natural Earth outlines stay underneath as a fallback when basemap tiles are blocked or offline.
 Promise.all([fetch('/region.geojson').then(r=>r.json()),fetch('/lakes.geojson').then(r=>r.json())]).then(([region,lakes])=>{L.geoJSON(region,{pane:'outline',interactive:false,style:{color:'#c8d1bf',weight:1,fillColor:'#f0f2e6',fillOpacity:1}}).addTo(map);L.geoJSON(lakes,{pane:'outline',interactive:false,style:{color:'#b9d0d6',weight:1,fillColor:'#d6e6ea',fillOpacity:1}}).addTo(map);}).catch(()=>{});
 // OpenStreetMap standard tiles: towns, roads and lakes without an API key (light use with attribution and a referrer,
 // per the OSM tile usage policy). Radar draws above the tiles at partial opacity so labels stay readable.
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{pane:'base',maxZoom:19,crossOrigin:true,referrerPolicy:'strict-origin-when-cross-origin',attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
 const view=store.get('view',null);
 if(view&&Number.isFinite(view.lat))map.setView([view.lat,view.lon],view.zoom);else map.fitBounds(MICHIGAN,{padding:[10,10]});
 map.on('moveend',()=>{const c=map.getCenter();store.set('view',{lat:+c.lat.toFixed(4),lon:+c.lng.toFixed(4),zoom:map.getZoom()});});
 map.on('zoomend',zoomClass);zoomClass();
 addControls();radar=createRadar();if(prefs.radar)radar.start();
 return map;
}
export function destroyMap(){if(!map)return;radar?.stop();map.remove();map=null;markers=new Map();stationsById=new Map();selected=null;routeLayer=null;radar=null;}
export const mapReady=()=>!!map;
export function resize(){if(map)requestAnimationFrame(()=>map.invalidateSize({pan:false}));}
function zoomClass(){el.classList.toggle('zoom-detail',map.getZoom()>=7.5);el.classList.toggle('zoom-far',map.getZoom()<6.25);}
export function resetView(){map?.flyToBounds(MICHIGAN,{padding:[10,10],duration:0.6});}

// ---------- stations ----------
function markerHtml(s,ops){
 const h=stationHealth(s,ops),r=markerReading(s,prefs.variable),fill=h.code==='out'?'#5b2a2a':r.text?scaleColor(prefs.variable,r.reading?.value?.converted):'#d5dad4';
 const arrow=r.direction!==null&&r.direction!==undefined?`<b class="arr" style="transform:rotate(${(r.direction+180)%360}deg)">↑</b>`:'';
 return `<div class="stn h-${h.code}${s.id===selected?' sel':''}" style="--fill:${fill}"><span class="dot"></span>${r.text&&h.code!=='out'?`<span class="val">${arrow}${esc(r.text)}</span>`:''}${GLYPH[h.code]?`<i class="glyph">${GLYPH[h.code]}</i>`:''}</div>`;
}
function label(s,ops){const h=stationHealth(s,ops),r=markerReading(s,prefs.variable),m=MEASURES[prefs.variable];return `${s.name}. ${h.label}.${r.text?` ${m.label} ${r.text} ${r.reading.value.unit}.`:''}`;}
export function setStations(stations,ops){
 if(!map)return;lastOps=ops;const seen=new Set();
 for(const s of stations){
  if(!Number.isFinite(s.lat)||!Number.isFinite(s.lon))continue;
  seen.add(s.id);stationsById.set(s.id,s);
  const html=markerHtml(s,ops),title=label(s,ops);let m=markers.get(s.id);
  if(!m){m=L.marker([s.lat,s.lon],{icon:L.divIcon({className:'stn-icon',html,iconSize:null}),title,alt:title,keyboard:true,riseOnHover:true});m._html=html;m.on('click',()=>handlers.onSelect?.(s.id));m.on('keypress',e=>{if(e.originalEvent.key==='Enter')handlers.onSelect?.(s.id);});m.addTo(map);markers.set(s.id,m);}
  else{if(m._html!==html){m.setIcon(L.divIcon({className:'stn-icon',html,iconSize:null}));m._html=html;}const ll=m.getLatLng();if(ll.lat!==s.lat||ll.lng!==s.lon)m.setLatLng([s.lat,s.lon]);m.options.title=title;}
  m.setZIndexOffset(s.id===selected?1000:{out:600,sensor:400,qc:300,delayed:100}[stationHealth(s,ops).code]||0);
 }
 for(const [id,m] of markers)if(!seen.has(id)){m.remove();markers.delete(id);}
 renderLegend();
}
export function selectStation(id,{pan=true}={}){
 const prev=selected;selected=id||null;
 for(const sid of [prev,selected]){const m=markers.get(sid),s=stationsById.get(sid);if(m&&s){const html=markerHtml(s,lastOps);m.setIcon(L.divIcon({className:'stn-icon',html,iconSize:null}));m._html=html;m.setZIndexOffset(sid===selected?1000:0);}}
 if(pan&&selected&&markers.get(selected)){const panel=document.querySelector('#panel:not([hidden])'),wide=window.innerWidth>760;map.panInside(markers.get(selected).getLatLng(),{paddingTopLeft:[40,60],paddingBottomRight:[wide&&panel?panel.offsetWidth+30:40,wide?40:Math.round(window.innerHeight*0.55)]});}
}
export function focusStations(ids){const pts=ids.map(i=>markers.get(i)?.getLatLng()).filter(Boolean);if(!pts.length)return;if(pts.length===1)return selectStation(ids[0]);const panel=document.querySelector('#panel:not([hidden])');map.flyToBounds(L.latLngBounds(pts),{paddingTopLeft:[60,60],paddingBottomRight:[(panel&&window.innerWidth>760?panel.offsetWidth:0)+60,60],maxZoom:9,duration:0.6});}

// ---------- trip route ----------
// Only provider geometry is drawn as a road route. Without it, stops are numbered and no line is drawn.
export function showTrip({start,end,stops=[],geometry=null}){
 clearTrip();if(!map)return;routeLayer=L.layerGroup().addTo(map);
 if(geometry?.geometry?.length){const line=L.polyline(geometry.geometry,{pane:'route',color:geometry.synthetic?'#a03d31':'#19553f',weight:geometry.synthetic?2:5,opacity:0.85,dashArray:geometry.synthetic?'6 6':null}).addTo(routeLayer);if(geometry.synthetic)line.bindTooltip('SYNTHETIC straight-line placeholder — not a road route',{sticky:true});}
 const pin=(p,text,cls,title)=>{if(p&&Number.isFinite(p.lat))L.marker([p.lat,p.lon],{pane:'route',icon:L.divIcon({className:'trip-pin '+cls,html:`<span>${esc(text)}</span>`,iconSize:[24,24],iconAnchor:[12,12]}),title,keyboard:false,interactive:false}).addTo(routeLayer);};
 pin(start,'S','start','Start: '+(start?.label||''));
 if(end&&(end.lat!==start?.lat||end.lon!==start?.lon))pin(end,'E','start','Return: '+end.label);
 stops.forEach((s,i)=>pin(s,String(i+1),'stop',`${i+1}. ${s.name||s.stationId}`));
}
export function clearTrip(){if(routeLayer){routeLayer.remove();routeLayer=null;}}
export function fitTrip({start,stops=[],geometry=null}){const pts=[...(geometry?.geometry||[]),...stops.filter(s=>Number.isFinite(s.lat)).map(s=>[s.lat,s.lon]),...(start?[[start.lat,start.lon]]:[])];if(!pts.length)return;const panel=document.querySelector('#panel:not([hidden])');map.flyToBounds(L.latLngBounds(pts),{paddingTopLeft:[50,50],paddingBottomRight:[(panel&&window.innerWidth>760?panel.offsetWidth:0)+50,50],maxZoom:10,duration:0.5});}

// ---------- controls and legend ----------
function addControls(){
 const Tools=L.Control.extend({options:{position:'topleft'},onAdd(){
  const d=L.DomUtil.create('div','map-tools');L.DomEvent.disableClickPropagation(d);L.DomEvent.disableScrollPropagation(d);
  d.innerHTML=`<label class="sr-only" for="map-variable">Map shows</label><select id="map-variable" title="Weather value shown on markers">${MAP_VARIABLES.map(v=>`<option value="${v}" ${v===prefs.variable?'selected':''}>${esc(MEASURES[v].label)}</option>`).join('')}</select><button type="button" id="map-reset" title="Show the whole network">Michigan</button>`;
  d.querySelector('#map-variable').onchange=e=>{prefs.variable=e.target.value;store.set('prefs',prefs);setStations([...stationsById.values()],lastOps);};
  d.querySelector('#map-reset').onclick=resetView;return d;}});
 new Tools().addTo(map);
 const Radar=L.Control.extend({options:{position:'bottomleft'},onAdd(){
  const d=L.DomUtil.create('div','radar-tools');L.DomEvent.disableClickPropagation(d);L.DomEvent.disableScrollPropagation(d);
  d.innerHTML=`<label class="radar-on"><input type="checkbox" id="radar-on" ${prefs.radar?'checked':''}> Radar</label><button type="button" id="radar-play" aria-label="Play past hour of observed radar" title="Play past hour (observed, not a forecast)">▶</button><span id="radar-time" class="radar-time" aria-live="polite">—</span><label class="sr-only" for="radar-opacity">Radar opacity</label><input id="radar-opacity" type="range" min="20" max="100" value="${Math.round(prefs.opacity*100)}" title="Radar opacity"><details class="radar-info"><summary aria-label="Radar timing details">i</summary><p id="radar-detail"></p></details>`;
  statusEl=d;
  d.querySelector('#radar-on').onchange=e=>{prefs.radar=e.target.checked;store.set('prefs',prefs);prefs.radar?radar.start():radar.stop();};
  d.querySelector('#radar-play').onclick=()=>radar.toggle();
  d.querySelector('#radar-opacity').oninput=e=>{prefs.opacity=Number(e.target.value)/100;store.set('prefs',prefs);radar.opacity(prefs.opacity);};
  return d;}});
 new Radar().addTo(map);
 const Legend=L.Control.extend({options:{position:'bottomleft'},onAdd(){legendEl=L.DomUtil.create('div','map-legend');L.DomEvent.disableClickPropagation(legendEl);renderLegend();return legendEl;}});
 new Legend().addTo(map);
}
function renderLegend(){
 if(!legendEl)return;const m=MEASURES[prefs.variable],stops=SCALES[prefs.variable];
 legendEl.innerHTML=`<details ${store.get('legend',window.innerWidth>760)?'open':''}><summary>Legend</summary><div class="lg-scale"><span>${esc(m.label)} (${esc(m.unit)})</span><div class="lg-ramp">${stops.map(([v,c])=>`<i style="background:${c}" title="${v}"></i>`).join('')}</div><div class="lg-ends"><span>${stops[0][0]}</span><span>${stops.at(-1)[0]}</span></div></div><ul class="lg-health"><li><span class="stn h-ok"><span class="dot"></span></span>Reporting</li><li><span class="stn h-delayed"><span class="dot"></span><i class="glyph">◷</i></span>Delayed</li><li><span class="stn h-sensor"><span class="dot"></span><i class="glyph">▲</i></span>Sensor missing</li><li><span class="stn h-out"><span class="dot"></span><i class="glyph">✕</i></span>Not reporting</li><li><span class="stn h-qc"><span class="dot"></span><i class="glyph">?</i></span>QC to review</li></ul><p class="lg-note">Markers show only fresh, unflagged readings.</p></details>`;
 legendEl.querySelector('details').ontoggle=e=>store.set('legend',e.target.open);
}

// ---------- radar ----------
// Observed frames only: each frame is the NWS composite valid at an exact scan time. Nothing is extrapolated.
const merc=([lat,lon])=>[lon*20037508.34/180,Math.log(Math.tan((90+lat)*Math.PI/360))*20037508.34/Math.PI];
function frameUrl(ts){
 const [x1,y1]=merc(RADAR_BOUNDS[0]),[x2,y2]=merc(RADAR_BOUNDS[1]),w=1200,h=Math.round(w*(y2-y1)/(x2-x1));
 return `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=nexrad-n0q-wmst&STYLES=&SRS=EPSG:3857&BBOX=${x1},${y1},${x2},${y2}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true&TIME=${encodeURIComponent(new Date(ts).toISOString().replace('.000Z','Z'))}`;
}
function createRadar(){
 let frames=[],overlays=new Map(),current=-1,timer=null,refreshTimer=null,playing=false,listFetchedAt=null,error='',active=false;
 const status=()=>{
  if(!statusEl)return;const t=statusEl.querySelector('#radar-time'),dEl=statusEl.querySelector('#radar-detail'),play=statusEl.querySelector('#radar-play');
  play.textContent=playing?'❚❚':'▶';play.disabled=!active||frames.length<2;play.setAttribute('aria-label',playing?'Pause radar':'Play past hour of observed radar');
  if(!active){t.textContent='Off';dEl.textContent='Radar is off. Stations are unaffected.';return;}
  if(error&&!frames.length){t.textContent='Radar unavailable';dEl.textContent=`${error} Station data is unaffected.`;return;}
  const f=frames[current];if(!f){t.textContent='Loading radar…';return;}
  const latest=current===frames.length-1;t.textContent=`${latest?'Latest':'Past'} · ${time(f.ts)}`;
  dEl.innerHTML=`Observed radar, not a forecast. Frame valid ${time(f.ts)} ET${f.loadedAt?`; image retrieved ${time(f.loadedAt)}`:''}${listFetchedAt?`; frame list checked ${time(listFetchedAt)}`:''}. ${frames.length} frames over the past ${Math.round((frames.at(-1).ts-frames[0].ts)/60000)} minutes. ${RADAR_SOURCE}. Blank areas can mean no echoes or missing coverage; radar is not measured rainfall.${f.failed?' This frame failed to load.':''}`;
 };
 const overlay=i=>{const f=frames[i];if(!overlays.has(f.ts)){const o=L.imageOverlay(frameUrl(f.ts),RADAR_BOUNDS,{pane:'radar',opacity:0,interactive:false,crossOrigin:false,alt:`Observed radar valid ${time(f.ts)}`});o.on('load',()=>{f.loadedAt=Date.now();status();});o.on('error',()=>{f.failed=true;status();});o.addTo(map);overlays.set(f.ts,o);}return overlays.get(f.ts);};
 const show=i=>{current=i;frames.forEach((f,j)=>{if(overlays.has(f.ts)||j===i)overlay(j).setOpacity(j===i?prefs.opacity:0);});status();};
 async function load(){
  const end=new Date(),start=new Date(end-80*60000),fmt=d=>d.toISOString().slice(0,16)+'Z';
  try{
   const r=await fetch(`https://mesonet.agron.iastate.edu/json/radar.py?operation=list&product=N0Q&radar=USCOMP&start=${fmt(start)}&end=${fmt(end)}`,{signal:AbortSignal.timeout(15000)});
   if(!r.ok)throw Error('Radar frame list unavailable.');
   const scans=((await r.json()).scans||[]).map(s=>Date.parse(s.ts)).filter(Number.isFinite).sort((a,b)=>a-b);
   if(!scans.length)throw Error('No recent radar frames were listed.');
   const picked=[];for(let i=scans.length-1;i>=0&&picked.length<7;i--)if(!picked.length||picked[0]-scans[i]>=9.5*60000)picked.unshift(scans[i]);
   listFetchedAt=Date.now();error='';
   if(frames.at(-1)?.ts===picked.at(-1))return false;
   for(const [ts,o] of overlays)if(!picked.includes(ts)){o.remove();overlays.delete(ts);}
   frames=picked.map(ts=>frames.find(f=>f.ts===ts)||{ts});return true;
  }catch(e){error=e.name==='TimeoutError'?'Radar service did not respond.':e.message||'Radar unavailable.';status();return false;}
 }
 return {
  async start(){active=true;status();const changed=await load();if(!active)return;if(frames.length&&(changed||current<0))show(frames.length-1);status();clearInterval(refreshTimer);refreshTimer=setInterval(async()=>{if(document.hidden||!active||playing)return;if(await load())show(frames.length-1);},5*60000);},
  stop(){active=false;playing=false;clearInterval(timer);clearInterval(refreshTimer);for(const o of overlays.values())o.remove();overlays.clear();current=-1;frames.forEach(f=>{delete f.loadedAt;});status();},
  toggle(){if(!active||frames.length<2)return;playing=!playing;clearInterval(timer);if(playing){frames.forEach((f,i)=>overlay(i));let i=0;show(0);timer=setInterval(()=>{i=(i+1)%(frames.length+2);show(Math.min(i,frames.length-1));},700);}else show(frames.length-1);},
  opacity(v){if(current>=0&&frames[current])overlay(current).setOpacity(v);}
 };
}
