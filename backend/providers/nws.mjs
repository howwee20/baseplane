// National Weather Service API client (server-side only). Fetches are restricted to api.weather.gov,
// grid identifiers are validated, and responses are trimmed and cached with bounded TTLs.
import {AppError} from '../storage.mjs';
import {cacheRead,cacheWrite,boundedFetch} from './cache.mjs';
import {parseGridpoints,parseAlerts} from '../../web/lib/fleet/forecast.mjs';
const BASE='https://api.weather.gov';
const GRID_FIELDS=['temperature','windSpeed','windGust','probabilityOfPrecipitation','quantitativePrecipitation','probabilityOfThunder','skyCover','weather'];
const headers=env=>({'User-Agent':env.NWS_USER_AGENT||'(atolldb.com, Enviroweather Fleet)','Accept':'application/geo+json'});
export const validCoordinate=(lat,lon)=>Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=40&&lat<=49.5&&lon>=-92&&lon<=-80;
async function get(env,path){
 const url=new URL(path,BASE);if(url.origin!==BASE)throw new AppError('Forecast provider URL rejected.',400);
 let res;try{res=await boundedFetch(url,{headers:headers(env)},{timeoutMs:20000,retries:1});}catch{throw new AppError('The National Weather Service did not respond. Forecast-dependent plan checks are unavailable.',503);}
 if(res.status===404)throw new AppError('No NWS forecast grid covers this location.',404);
 if(!res.ok)throw new AppError('The National Weather Service returned an error. Forecast-dependent plan checks are unavailable.',503);
 return res.json();
}
export async function nwsPoint(env,lat,lon){
 if(!validCoordinate(lat,lon))throw new AppError('Forecast location must be in the Michigan service area.');
 const la=lat.toFixed(4),lo=lon.toFixed(4),key=`nws:point:${la},${lo}`,hit=await cacheRead(env.DB,key);if(hit)return hit.body;
 const p=(await get(env,`/points/${la},${lo}`)).properties||{};
 const gridId=String(p.gridId||''),gridX=Number(p.gridX),gridY=Number(p.gridY);
 if(!/^[A-Z]{3}$/.test(gridId)||!Number.isInteger(gridX)||!Number.isInteger(gridY)||gridX<0||gridY<0||gridX>999||gridY>999)throw new AppError('NWS returned an unexpected forecast grid.',503);
 const zone=u=>{const m=/\/zones\/(?:forecast|county|fire)\/([A-Z]{2}[CZ]\d{3})$/.exec(String(u||''));return m?m[1]:null;};
 const body={gridId,gridX,gridY,forecastZone:zone(p.forecastZone),county:zone(p.county),timeZone:p.timeZone||null};
 // NWS asks clients to re-check points periodically; a week keeps grid remapping visible.
 await cacheWrite(env.DB,key,body,7*864e5);return body;
}
export async function nwsGrid(env,{gridId,gridX,gridY}){
 if(!/^[A-Z]{3}$/.test(gridId)||!Number.isInteger(gridX)||!Number.isInteger(gridY))throw new AppError('Invalid forecast grid.');
 const key=`nws:grid:${gridId}/${gridX},${gridY}`,hit=await cacheRead(env.DB,key);if(hit)return {...hit.body,cached:true};
 const raw=await get(env,`/gridpoints/${gridId}/${gridX},${gridY}`),props=raw.properties||{},trimmed={properties:{updateTime:props.updateTime,validTimes:props.validTimes}};
 for(const k of GRID_FIELDS)if(props[k])trimmed.properties[k]=props[k];
 const fetchedAt=new Date().toISOString(),parsed=parseGridpoints(trimmed,{fetchedAt,gridId:`${gridId}/${gridX},${gridY}`});
 await cacheWrite(env.DB,key,parsed,60*60000,fetchedAt);return {...parsed,cached:false};
}
export async function nwsAlerts(env){
 const key='nws:alerts:MI',hit=await cacheRead(env.DB,key);if(hit)return hit.body;
 const raw=await get(env,'/alerts/active?area=MI'),fetchedAt=new Date().toISOString(),body={fetchedAt,updated:raw.updated||null,alerts:parseAlerts(raw)};
 await cacheWrite(env.DB,key,body,5*60000,fetchedAt);return body;
}
// Forecasts for a bounded list of locations, fetched sequentially to respect NWS rate limits.
export async function forecastsFor(env,locations,{limit=24}={}){
 if(locations.length>limit)throw new AppError(`Request forecasts for at most ${limit} stations at a time.`);
 const out={},grids=new Map();let alerts={alerts:[],fetchedAt:null,error:null};
 try{alerts=await nwsAlerts(env);}catch(e){alerts.error=e.message;}
 for(const loc of locations){
  try{const point=await nwsPoint(env,loc.lat,loc.lon),gk=`${point.gridId}/${point.gridX},${point.gridY}`;if(!grids.has(gk))grids.set(gk,await nwsGrid(env,point));out[loc.id]={point,forecast:grids.get(gk),zones:[point.forecastZone,point.county].filter(Boolean)};}
  catch(e){out[loc.id]={error:e instanceof AppError?e.message:'Forecast unavailable.'};}
 }
 return {forecasts:out,alerts};
}
