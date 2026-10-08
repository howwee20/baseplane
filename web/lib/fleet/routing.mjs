// Road-routing data shapes and navigation links. Great-circle distance may shortlist stations but is never
// presented as driving distance or time; matrices come from a real routing provider behind an adapter.
export const ROUTING_VERSION='routing-v1';
export const ORS_ATTRIBUTION='© openrouteservice by HeiGIT · Data from OpenStreetMap contributors (results CC-BY-SA 4.0)';
const round=v=>Math.round(v*1e5)/1e5;
// Normalizes an OpenRouteService /v2/matrix response. null entries mean the provider found no route.
export function normalizeOrsMatrix(json,points,{fetchedAt=new Date().toISOString()}={}){
 const n=points.length,durations=[],distances=[],unreachable=[];
 if(!Array.isArray(json?.durations)||json.durations.length!==n)throw Error('Routing provider returned an incomplete matrix.');
 for(let i=0;i<n;i++){durations.push([]);distances.push([]);for(let j=0;j<n;j++){const d=json.durations[i]?.[j],m=json.distances?.[i]?.[j];const ok=typeof d==='number'&&Number.isFinite(d)&&(i===j||d>0||m===0);durations[i].push(ok?d:null);distances[i].push(typeof m==='number'&&Number.isFinite(m)?m:null);if(!ok&&i!==j)unreachable.push({from:points[i].id,to:points[j].id});}}
 const snapped=(json.sources||[]).map((s,i)=>({id:points[i]?.id,snappedDistanceM:typeof s?.snapped_distance==='number'?s.snapped_distance:null}));
 return {version:ROUTING_VERSION,provider:'openrouteservice',profile:'driving-car',fetchedAt,traffic:'none',trafficNote:'Typical road speeds without live or departure-time traffic.',attribution:ORS_ATTRIBUTION,points:points.map((p,i)=>({id:p.id,lat:p.lat,lon:p.lon,snappedDistanceM:snapped[i]?.snappedDistanceM??null})),durations,distances,unreachable};
}
// Road matrices are fetched and cached in a canonical (sorted) point order so reordering trip stops never triggers a
// new provider request; this maps a canonical matrix back to the caller's order.
export const pointKey=p=>`${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`;
export function canonicalOrder(points){return points.map((p,i)=>({p,i,k:pointKey(p)})).sort((a,b)=>a.k<b.k?-1:a.k>b.k?1:a.i-b.i).map(x=>x.i);}
export function permuteMatrix(canonical,points,order){
 const pos=new Map(order.map((orig,c)=>[orig,c])),n=points.length,durations=[],distances=[],unreachable=[];
 for(let i=0;i<n;i++){durations.push([]);distances.push([]);for(let j=0;j<n;j++){const d=canonical.durations[pos.get(i)][pos.get(j)];durations[i].push(d);distances[i].push(canonical.distances[pos.get(i)][pos.get(j)]);if(d===null&&i!==j)unreachable.push({from:points[i].id,to:points[j].id});}}
 return {...canonical,points:points.map((p,i)=>({id:p.id,lat:p.lat,lon:p.lon,snappedDistanceM:canonical.points[pos.get(i)]?.snappedDistanceM??null})),durations,distances,unreachable};
}
export function matrixIndex(matrix){return new Map(matrix.points.map((p,i)=>[p.id,i]));}
export function leg(matrix,from,to,index=matrixIndex(matrix)){const i=index.get(from),j=index.get(to);if(i===undefined||j===undefined)return null;const d=matrix.durations[i][j];return d===null||d===undefined?null:{durationSec:d,distanceM:matrix.distances[i][j]};}
export function orsDirectionsToRoute(json){
 const f=json?.features?.[0],coords=f?.geometry?.coordinates;if(!Array.isArray(coords)||!coords.length)throw Error('Routing provider returned no route geometry.');
 const step=Math.max(1,Math.ceil(coords.length/3000));
 return {geometry:coords.filter((_,i)=>i%step===0||i===coords.length-1).map(([lon,lat])=>[round(lat),round(lon)]),distanceM:f.properties?.summary?.distance??null,durationSec:f.properties?.summary?.duration??null,legs:(f.properties?.segments||[]).map(s=>({distanceM:s.distance,durationSec:s.duration})),attribution:ORS_ATTRIBUTION};
}
// Navigation links contain coordinates only; access notes and gate codes never enter URLs.
export function navigationLinks(stops,{waypointsPerLink=3}={}){
 const pts=stops.filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lon)),c=s=>`${round(s.lat)},${round(s.lon)}`,google=[],apple=[];
 for(let i=0;i<pts.length-1;){
  const end=Math.min(pts.length-1,i+waypointsPerLink+1),chunk=pts.slice(i,end+1);
  const q=new URLSearchParams({api:'1',origin:c(chunk[0]),destination:c(chunk.at(-1)),travelmode:'driving'});if(chunk.length>2)q.set('waypoints',chunk.slice(1,-1).map(c).join('|'));
  google.push({label:`${chunk[0].label} → ${chunk.at(-1).label}${chunk.length>2?` (${chunk.length-2} stop${chunk.length===3?'':'s'} between)`:''}`,url:'https://www.google.com/maps/dir/?'+q.toString()});i=end;
 }
 for(let i=0;i<pts.length-1;i++)apple.push({label:`${pts[i].label} → ${pts[i+1].label}`,url:'https://maps.apple.com/?'+new URLSearchParams({saddr:c(pts[i]),daddr:c(pts[i+1]),dirflg:'d'}).toString()});
 return {google,apple,note:'Google Maps links carry at most three intermediate stops so they open on mobile browsers. Apple Maps links are one leg each.'};
}
// Synthetic matrices for tests only. Never used for live operational evidence.
export function fixtureMatrix(points,table,{fetchedAt='2026-10-07T12:00:00.000Z'}={}){
 const idx=new Map(points.map((p,i)=>[p.id,i])),n=points.length,durations=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?0:null)),distances=durations.map(r=>r.map(v=>v===0?0:null));
 for(const [k,[min,km]] of Object.entries(table)){const [a,b]=k.split('>');if(!idx.has(a)||!idx.has(b))continue;durations[idx.get(a)][idx.get(b)]=min*60;distances[idx.get(a)][idx.get(b)]=km*1000;}
 const unreachable=[];for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(i!==j&&durations[i][j]===null)unreachable.push({from:points[i].id,to:points[j].id});
 return {version:ROUTING_VERSION,provider:'synthetic-fixture',synthetic:true,profile:'driving-car',fetchedAt,traffic:'none',attribution:'Synthetic test matrix',points:points.map(p=>({...p,snappedDistanceM:null})),durations,distances,unreachable};
}
