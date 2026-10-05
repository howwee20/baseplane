import {distance} from '../comparison.js';

export const VARIABLES={
 air_temp:{label:'Air temperature',tolerance:3,units:['Celsius','C','degC'],change:1},
 relative_humidity:{label:'Relative humidity',tolerance:20,units:['%','percent'],change:5},
 wind_speed:{label:'Wind speed',tolerance:3,units:['m/s','Meters per second'],change:1},
 solar_radiation:{label:'Solar radiation',tolerance:200,units:['W/m**2','W/m2','W/m²','Watts per square meter'],change:75},
 precip_accum_one_hour:{label:'Rainfall · preceding hour',tolerance:5,units:['Millimeters','mm'],change:1}
};
export const DEFAULTS={radiusKm:100,minNeighbors:3,toleranceScale:1,alignmentMinutes:5,maxAgeMinutes:90};
export function settings(input={}){const s={...DEFAULTS,...input};if(![25,50,100,150].includes(s.radiusKm)||![2,3,4].includes(s.minNeighbors)||![0.5,1,1.5,2,3].includes(s.toleranceScale)||![30,60,90,120,180].includes(s.maxAgeMinutes))throw Error('Choose a supported radius, minimum neighbor count, tolerance and maximum reading age.');return s;}
export const median=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length?a.length%2?a[i]:(a[i-1]+a[i])/2:null;};
export function nearby(target,stations,radiusKm=100){const chosen=[];for(const s of stations.filter(s=>s.id!==target.id&&s.archiveStatus!=='INACTIVE').map(s=>({...s,distance:distance(target,s)})).filter(s=>s.distance>=0.5&&s.distance<=radiusKm).sort((a,b)=>a.distance-b.distance)){if(chosen.every(other=>distance(s,other)>=0.5))chosen.push(s);if(chosen.length===5)break;}return chosen;}
const usable=p=>p&&Number.isFinite(p.t)&&Number.isFinite(p.v)&&!p.flagged;
export function aligned(points,time,tolerance=300000){let best=null;for(const p of points||[])if(usable(p)&&Math.abs(p.t-time)<=tolerance&&(!best||Math.abs(p.t-time)<Math.abs(best.t-time)))best=p;return best;}
function rule(variable,unit,scale){const v=VARIABLES[variable];return v?.units.includes(unit)?v.tolerance*scale:null;}
export function band(values,floor){const center=median(values),mad=median(values.map(v=>Math.abs(v-center))),width=Math.max(floor,3*1.4826*mad);return {median:center,mad,tolerance:width,low:center-width,high:center+width,min:Math.min(...values),max:Math.max(...values)};}
function reading(station,variable){const f=station.fields?.filter(f=>f.variable===variable&&!f.derived).sort((a,b)=>a.key.localeCompare(b.key))[0];return f?{t:Date.parse(f.time),v:f.value,unit:f.unit,flagged:!!f.qc?.length||f.qcStatus==='failed',sensor:f.key}:null;}

export function latestReport(network,input={},now=Date.now()){
 const options=settings(input),stations=network.stations.filter(s=>s.archiveStatus!=='INACTIVE'),rows=[];
 for(const station of stations)for(const variable of Object.keys(VARIABLES)){
  const p=reading(station,variable),row={stationId:station.id,stationName:station.name,variable,label:VARIABLES[variable].label,unit:p?.unit||null,value:p?.v??null,time:Number.isFinite(p?.t)?new Date(p.t).toISOString():null,status:'insufficient',reason:'No usable primary reading.',neighbors:[]};
  const floor=rule(variable,p?.unit,options.toleranceScale);
  if(!p||!Number.isFinite(p.v)||!Number.isFinite(p.t)){rows.push(row);continue;}
  if(p.flagged){row.status='excluded';row.reason='Target reading has a QC flag.';rows.push(row);continue;}
  if(now-p.t>options.maxAgeMinutes*60000||p.t-now>300000){row.status='excluded';row.reason='Target reading is stale or ahead of the service clock.';rows.push(row);continue;}
  if(floor===null){row.reason='Unit unavailable or no provisional tolerance for this unit.';rows.push(row);continue;}
  row.neighbors=nearby(station,stations,options.radiusKm).map(s=>({station:s,reading:reading(s,variable)})).filter(({reading:q})=>usable(q)&&q.unit===p.unit&&Math.abs(q.t-p.t)<=options.alignmentMinutes*60000&&now-q.t<=options.maxAgeMinutes*60000&&q.t-now<=300000).map(({station:s,reading:q})=>({id:s.id,name:s.name,distanceKm:s.distance,value:q.v,time:new Date(q.t).toISOString()}));
  if(row.neighbors.length<options.minNeighbors){row.reason=`Need ${options.minNeighbors} matching, unflagged neighbors within ±${options.alignmentMinutes} minutes; found ${row.neighbors.length}.`;rows.push(row);continue;}
  row.reference=band(row.neighbors.map(n=>n.value),floor);row.delta=p.v-row.reference.median;row.status=p.v<row.reference.low||p.v>row.reference.high?'review':'in-range';row.reason=row.status==='review'?'Outside the provisional nearby reference range; inspect local weather and sensor exposure.':'Within the provisional nearby reference range.';row.localVariation=row.reference.max-row.reference.min>2*floor;rows.push(row);
 }
 return {schemaVersion:1,kind:'enviroweather-anomaly-report',generatedAt:new Date(now).toISOString(),networkFetchedAt:network.fetchedAt,settings:options,stationCount:stations.length,rows,summary:{review:rows.filter(r=>r.status==='review').length,inRange:rows.filter(r=>r.status==='in-range').length,insufficient:rows.filter(r=>r.status==='insufficient').length,excluded:rows.filter(r=>r.status==='excluded').length},method:'Median of the nearest five active station locations in the selected radius, at least 500 m apart from each other and the target, matching units, unflagged primary channels, aligned within ±5 minutes. Range half-width is max(provisional tolerance, 3 × 1.4826 × median absolute deviation).',limitations:['This is a review screen, not a confirmed equipment diagnosis.','Latest-snapshot screening does not infer historical weather patterns. Open the reference tracker for changes over time.','Terrain, coastlines, sensor exposure, local clouds and storms can produce real differences.','Thresholds are provisional. Rainfall and solar radiation can vary sharply across short distances.','No elevation or sensor-height correction is applied.']};
}

function context(rows,variable,options){
 const good=rows.filter(r=>r.reference),latest=good.at(-1);if(!latest)return {kind:'unavailable',message:'Insufficient aligned readings to compare a weather pattern.'};
 const previous=good.filter(r=>r.t<=latest.t-45*60000&&r.t>=latest.t-75*60000).sort((a,b)=>Math.abs(a.t-(latest.t-3600000))-Math.abs(b.t-(latest.t-3600000)))[0];
 if(!previous)return {kind:'unavailable',message:'No comparable reference about one hour earlier; weather-change context is unavailable.'};
 // Hold reference membership fixed so a station entering/leaving cannot create a false weather trend.
 const ids=latest.neighbors.map(n=>n.id).filter(id=>previous.neighbors.some(n=>n.id===id));
 if(ids.length<options.minNeighbors)return {kind:'unavailable',message:'Too few of the same neighbors report at both times to compare a weather trend.'};
 const peerChanges=ids.map(id=>latest.neighbors.find(n=>n.id===id).value-previous.neighbors.find(n=>n.id===id).value),referenceChange=median(peerChanges),targetChange=latest.value-previous.value,threshold=VARIABLES[variable].change*options.toleranceScale,tracks=Math.abs(targetChange-referenceChange)<=Math.max(threshold,latest.reference.tolerance/2),regional=Math.abs(referenceChange)>=threshold;
 const common={start:new Date(previous.t).toISOString(),end:new Date(latest.t).toISOString(),targetChange,referenceChange,neighbors:ids.length,peerChanges};
 if(variable==='precip_accum_one_hour')return {...common,kind:tracks?'local-rainfall':'isolated-change',message:tracks?'Recent rainfall changes track nearby reports. Local storm placement can still produce different totals.':'Rainfall changes differ from the reference. Check local storm placement and radar before treating the gauge as faulty.'};
 if(tracks&&regional)return {...common,kind:latest.status==='review'?'shared-change-offset':'shared-change',message:latest.status==='review'?'The station follows the nearby change, but its reading remains offset from the reference range. Review exposure, terrain and calibration.':'The station follows the nearby weather change and is inside the reference range.'};
 if(!tracks)return {...common,kind:'isolated-change',message:'The station changed differently from the same nearby references. Review the sensor and local weather together.'};
 return {...common,kind:latest.status==='review'?'persistent-offset':'steady',message:latest.status==='review'?'The nearby weather is relatively steady and the station remains offset. Check exposure and measurement history.':'The station and nearby reference are relatively steady.'};
}
export function referenceTracker(target,peers,variable,input={},now=Date.now()){
 const options=settings(input),floor=rule(variable,target.unit,options.toleranceScale),rows=[];
 if(!VARIABLES[variable])throw Error('Choose a supported weather variable.');
 for(const p of target.points||[]){
  const row={t:p.t,time:new Date(p.t).toISOString(),value:p.v,status:'excluded',reason:p.flagged?'Target QC flag':'Unavailable target reading',neighbors:[]};
  if(!usable(p)||p.t>now+300000){rows.push(row);continue;}
  row.status='insufficient';row.reason=floor===null?'Unit unavailable or unsupported tolerance.':'Too few aligned, unflagged neighbors.';
  if(floor===null){rows.push(row);continue;}
  row.neighbors=peers.filter(s=>s.unit===target.unit).map(s=>({station:s.station,point:aligned(s.points,p.t,options.alignmentMinutes*60000)})).filter(({point})=>usable(point)&&point.t<=now+300000).map(({station,point})=>({id:station.id,name:station.name,distanceKm:station.distance,value:point.v,time:new Date(point.t).toISOString()}));
  if(row.neighbors.length<options.minNeighbors){rows.push(row);continue;}
  row.reference=band(row.neighbors.map(n=>n.value),floor);row.delta=p.v-row.reference.median;row.status=p.v<row.reference.low||p.v>row.reference.high?'review':'in-range';row.reason=row.status==='review'?'Outside reference range':'Inside reference range';rows.push(row);
 }
 const evaluated=rows.filter(r=>r.reference),outside=evaluated.filter(r=>r.status==='review'),latest=rows.at(-1)||null,offset=median(evaluated.map(r=>r.delta));
 return {schemaVersion:1,kind:'enviroweather-reference-tracker',generatedAt:new Date(now).toISOString(),variable,label:VARIABLES[variable].label,unit:target.unit||null,settings:options,rows,latest,summary:{targetReadings:rows.length,evaluated:evaluated.length,outside:outside.length,outsidePercent:evaluated.length?100*outside.length/evaluated.length:null,coveragePercent:rows.length?100*evaluated.length/rows.length:0,medianOffset:offset,persistent:outside.length>=6&&outside.length/evaluated.length>=0.5},weather:context(rows,variable,options),limitations:['Aligned primary observations and returned QC only; missing references are unscorable.','Reference locations are at least 500 m apart from each other and the target; this does not prove equivalent sensor placement.','A persistent difference needs at least six outside-range observations and at least 50% of evaluated observations. This does not establish a duration or hardware fault.','The reference band adapts to nearby spread; tolerance floors are provisional.','Weather-change context uses the same reference stations about one hour apart.','Local storms, terrain, exposure and sensor height can cause legitimate differences. Current radar is not a historical replay.']};
}
