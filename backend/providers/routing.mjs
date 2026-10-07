// Road-routing provider adapter. OpenRouteService is the implemented provider: its results may be displayed on the
// app's Leaflet/OSM map and cached. Google Routes was evaluated and not used: its Service Specific Terms (§19.2)
// forbid use with a non-Google map and its general terms prohibit caching durations, which saved plans require.
import {AppError} from '../storage.mjs';
import {cacheRead,cacheWrite,boundedFetch} from './cache.mjs';
import {normalizeOrsMatrix,orsDirectionsToRoute,ORS_ATTRIBUTION} from '../../web/lib/fleet/routing.mjs';
import {validCoordinate} from './nws.mjs';
const ORS='https://api.openrouteservice.org';
export const MAX_MATRIX_POINTS=40;// ORS Standard allows 3,500 elements; 40×40 = 1,600 keeps headroom.
// Synthetic routing exists only for the local dev harness (backend/dev); production config never sets ROUTING_FIXTURE.
const synthetic=env=>env.ROUTING_FIXTURE==='synthetic';
function syntheticMatrix(points){const n=points.length,hav=(a,b)=>{const r=x=>x*Math.PI/180,v=Math.sin(r(b.lat-a.lat)/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(r(b.lon-a.lon)/2)**2;return 6371*2*Math.asin(Math.sqrt(v));};const durations=[],distances=[];for(let i=0;i<n;i++){durations.push([]);distances.push([]);for(let j=0;j<n;j++){const km=hav(points[i],points[j])*1.35;durations[i].push(i===j?0:Math.round(km/72*3600*(i<j?1:1.03)));distances[i].push(Math.round(km*1000));}}return {version:'routing-v1',provider:'synthetic-fixture',synthetic:true,profile:'driving-car',fetchedAt:new Date().toISOString(),traffic:'none',attribution:'SYNTHETIC routing fixture — not real driving times',points:points.map(p=>({...p,snappedDistanceM:null})),durations,distances,unreachable:[]};}
export function routingStatus(env){
 if(synthetic(env))return {provider:'synthetic-fixture',configured:true,synthetic:true,profile:'driving-car',traffic:'none',attribution:'SYNTHETIC routing fixture — not real driving times',limits:{matrixPerDay:0,matrixPerMinute:0,directionsPerDay:0,maxMatrixPoints:MAX_MATRIX_POINTS,maxWaypoints:50,plan:'Local synthetic fixture'},setup:null};
 const configured=!!env.ORS_API_KEY;
 return {provider:configured?'openrouteservice':null,configured,profile:'driving-car',traffic:'none',attribution:ORS_ATTRIBUTION,limits:{matrixPerDay:500,matrixPerMinute:40,directionsPerDay:2000,maxMatrixPoints:MAX_MATRIX_POINTS,maxWaypoints:50,plan:'OpenRouteService Standard (free) — verify current quotas at account.heigit.org'},
  setup:configured?null:'Road routing is not configured. Create an OpenRouteService (HeiGIT) API key — the Standard plan is free; MSU may qualify for the Collaborative plan — then run `npx wrangler secret put ORS_API_KEY` from backend/ and deploy the Worker. No purchase is required.'};
}
const key=points=>points.map(p=>`${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(';');
async function digestKey(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,40);}
function validatePoints(points,max){
 if(!Array.isArray(points)||points.length<2||points.length>max)throw new AppError(`Routing needs 2–${max} locations.`);
 for(const p of points)if(!validCoordinate(p.lat,p.lon)||typeof p.id!=='string'||!/^[A-Za-z0-9:_-]{1,100}$/.test(p.id))throw new AppError('Routing locations must be valid Michigan coordinates with simple identifiers.');
}
async function post(env,path,body){
 if(!env.ORS_API_KEY)throw new AppError(routingStatus(env).setup,503);
 let res;try{res=await boundedFetch(ORS+path,{method:'POST',headers:{'Authorization':env.ORS_API_KEY,'Content-Type':'application/json','Accept':'application/json, application/geo+json'},body:JSON.stringify(body)},{timeoutMs:30000,retries:1});}
 catch(e){throw new AppError(e.status===429?'Road-routing quota or rate limit reached. Retry later; saved plans remain available.':'Road routing is unavailable. Saved plans remain available.',503);}
 if(res.status===401||res.status===403)throw new AppError('Road-routing credentials were rejected. Check the ORS_API_KEY secret.',503);
 if(!res.ok)throw new AppError('Road routing could not compute this request.',503);
 return res.json();
}
export async function routeMatrix(env,points){
 validatePoints(points,MAX_MATRIX_POINTS);
 if(synthetic(env))return syntheticMatrix(points);
 const cacheKey='route:matrix:'+await digestKey(key(points)),hit=await cacheRead(env.DB,cacheKey);
 if(hit)return {...hit.body,points:points.map((p,i)=>({...hit.body.points[i],id:p.id})),cached:true};
 const json=await post(env,'/v2/matrix/driving-car',{locations:points.map(p=>[p.lon,p.lat]),metrics:['duration','distance'],units:'m'});
 const fetchedAt=new Date().toISOString(),m=normalizeOrsMatrix(json,points,{fetchedAt});
 await cacheWrite(env.DB,cacheKey,m,24*36e5,fetchedAt);return {...m,cached:false};
}
export async function routeGeometry(env,points){
 validatePoints(points,50);
 if(synthetic(env))return {geometry:points.map(p=>[p.lat,p.lon]),synthetic:true,distanceM:null,durationSec:null,legs:[],attribution:'SYNTHETIC straight-line placeholder — not a road route',fetchedAt:new Date().toISOString(),provider:'synthetic-fixture'};
 const cacheKey='route:path:'+await digestKey(key(points)),hit=await cacheRead(env.DB,cacheKey);if(hit)return {...hit.body,cached:true};
 const json=await post(env,'/v2/directions/driving-car/geojson',{coordinates:points.map(p=>[p.lon,p.lat]),instructions:false});
 const r={...orsDirectionsToRoute(json),fetchedAt:new Date().toISOString(),provider:'openrouteservice'};
 await cacheWrite(env.DB,cacheKey,r,24*36e5,r.fetchedAt);return {...r,cached:false};
}
