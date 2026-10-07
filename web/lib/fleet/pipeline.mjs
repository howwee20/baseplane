// One canonical pipeline from a provider snapshot to station assessments and incident updates.
// The Worker and the tests both call processSnapshot so there is a single rule implementation.
import {assessIngest,assessStation} from './health.mjs';
import {bootstrapProfile} from './profiles.mjs';
import {runEngine,FLEET_DEFAULTS} from './engine.mjs';
import {parseInstant} from './time.mjs';

export function maintenanceActive(note,now){const m=note?.maintenance;if(!m)return null;const from=parseInstant(m.from),until=parseInstant(m.until);return (!from||now>=from)&&(!until||now<until)?m:null;}
export function engineContext(notes={}){
 const regions={},dependencies={};
 for(const [id,n] of Object.entries(notes)){if(n?.region)regions[id]=n.region;if(Array.isArray(n?.dependencies)&&n.dependencies.length)dependencies[id]=n.dependencies;}
 return {regions,dependencies};
}
export function assessNetwork({metadata,latest,profiles={},notes={},thresholds={},config=FLEET_DEFAULTS,now=Date.now()}){
 const byId=new Map((latest?.STATION||[]).map(s=>[s.STID,s])),assessments=[],profileChanges=[],profileRows={};
 const stations=metadata?.STATION?.length?metadata.STATION:latest?.STATION||[];
 for(const meta of stations){
  const live=byId.get(meta.STID),merged={...meta,...live,SENSOR_VARIABLES:meta.SENSOR_VARIABLES||live?.SENSOR_VARIABLES,STATUS:meta.STATUS||live?.STATUS};
  const {rows,changed}=bootstrapProfile({stationId:meta.STID,meta,latest:live,units:latest?.UNITS||{},existing:profiles[meta.STID]||[],now,config});
  profileRows[meta.STID]=rows;profileChanges.push(...changed);
  assessments.push(assessStation({station:merged,profile:rows,units:latest?.UNITS||{},now,config:{...thresholds,channelLagMinutes:config.channelLagMinutes},maintenance:maintenanceActive(notes[meta.STID],now),inResponse:!!live}));
 }
 return {assessments,profileChanges,profileRows};
}
export function processSnapshot({metadata,latest,ingestId,retrievedAt,previousIngest=null,profiles={},notes={},stationStates={},incidents=[],thresholds={},config=FLEET_DEFAULTS,ids}){
 const now=Date.parse(retrievedAt),quality=assessIngest({metadata,latest,previous:previousIngest,now,config:{massOutageFraction:config.massOutageFraction,stale:thresholds.stale||180}});
 const ingest={id:ingestId,retrievedAt,status:'ok',...quality};
 const {assessments,profileChanges,profileRows}=assessNetwork({metadata,latest,profiles,notes,thresholds,config,now});
 const result=runEngine({ingest,assessments,stationStates,incidents,config,context:engineContext(notes),...(ids?{ids}:{})});
 return {ingest,assessments,profileChanges,profileRows,...result};
}
export function processFailure({ingestId,retrievedAt,reason,incidents=[],config=FLEET_DEFAULTS,ids}){
 const ingest={id:ingestId,retrievedAt,status:'failed',quality:'failed',reasons:[reason]};
 return {ingest,...runEngine({ingest,assessments:[],incidents,config,...(ids?{ids}:{})})};
}
