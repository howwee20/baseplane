// Extension point for Enviroweather model links (crop, pest and weather models) on the station panel.
// A station gets links only after the team has verified which Enviroweather station it is; names and coordinates are
// never used to guess. Both lists stay empty until a mapping and a destination have been checked by a person.
// Mapping entry: FLEET_ID: {id:'<Enviroweather station id>', verifiedBy:'<name>', verifiedAt:'YYYY-MM-DD'}
// Destination entry: {label:'<model name>', url:id=>`https://...${encodeURIComponent(id)}`}
export const VERIFIED_STATIONS=Object.freeze({});
export const MODEL_DESTINATIONS=Object.freeze([]);

export function modelLinks(stationId,{stations=VERIFIED_STATIONS,destinations=MODEL_DESTINATIONS}={}){
 const m=Object.hasOwn(stations,stationId)?stations[stationId]:null;
 if(!m||typeof m.id!=='string'||!m.id||!m.verifiedBy||!/^\d{4}-\d{2}-\d{2}$/.test(m.verifiedAt||''))return [];
 const out=[];
 for(const d of destinations){let url;try{url=new URL(d.url(m.id));}catch{continue;}if(url.protocol==='https:')out.push({label:d.label,url:url.href});}
 return out;
}
