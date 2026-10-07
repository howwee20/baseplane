// Groups fully non-reporting stations into candidate multi-station outages.
// Linking needs geographic AND onset proximity; a complete-linkage diameter and onset span stop chains of
// neighbours from merging distant regions. A shared cause is never inferred; only team-recorded dependencies link
// stations beyond the distance rule.
import {distance} from '../../comparison.js';
export const GROUPING_DEFAULTS={linkKm:40,maxDiameterKm:100,onsetWindowMinutes:180,minGroupSize:2};
export const GROUPING_RATIONALE='Defaults come from the October 2026 fleet: the median nearest active neighbour is 15 km and the 90th percentile is 36 km, so 40 km links most adjacent stations. The 100 km diameter cap prevents chains from spanning regions. Most channels report hourly and are polled every 15 minutes, so onset times are uncertain by roughly one reporting cycle; a 180-minute window allows staggered loggers. These are provisional defaults.';

export function validateGrouping(input={}){
 const g={...GROUPING_DEFAULTS,...input};
 if(!(g.linkKm>=5&&g.linkKm<=150)||!(g.maxDiameterKm>=g.linkKm&&g.maxDiameterKm<=400)||!(g.onsetWindowMinutes>=15&&g.onsetWindowMinutes<=1440)||!Number.isInteger(g.minGroupSize)||g.minGroupSize<2||g.minGroupSize>10)throw Error('Grouping: link 5–150 km, diameter ≥ link and ≤ 400 km, onset window 15–1440 minutes, minimum group size 2–10.');
 return g;
}
const shares=(a,b,deps)=>{const x=deps[a.id]||[],y=deps[b.id]||[];return x.find(d=>y.includes(d))||null;};

// candidates: [{id, lat, lon, onset (ms)}]; seeds: existing groups [{groupId, members:[ids], locked, excluded:[ids]}].
export function clusterOutages(candidates,options={},{seeds=[],regions={},dependencies={},optOut=[]}={}){
 const g=validateGrouping(options),byId=new Map(candidates.map(c=>[c.id,c])),assigned=new Set(),blocked=new Set(optOut),clusters=[];
 for(const seed of seeds){
  const members=seed.members.filter(id=>byId.has(id)&&!assigned.has(id)&&!blocked.has(id));
  members.forEach(id=>assigned.add(id));
  clusters.push({seedGroupId:seed.groupId,locked:!!seed.locked,excluded:new Set(seed.excluded||[]),members:members.map(id=>byId.get(id)),links:[]});
 }
 const remaining=candidates.filter(c=>!assigned.has(c.id)&&!blocked.has(c.id)).sort((a,b)=>(a.onset??Infinity)-(b.onset??Infinity)||a.id.localeCompare(b.id));
 for(const c of remaining){
  let best=null;
  for(const cl of clusters){
   if(cl.locked||cl.excluded.has(c.id)||!cl.members.length)continue;
   if(regions[c.id]&&cl.members.some(m=>regions[m.id]&&regions[m.id]!==regions[c.id]))continue;
   const onsets=[...cl.members,c].map(m=>m.onset).filter(Number.isFinite);
   if(onsets.length&&Math.max(...onsets)-Math.min(...onsets)>g.onsetWindowMinutes*60000)continue;
   let link=null,nearest=Infinity,fits=true;
   for(const m of cl.members){
    const d=distance(c,m),dep=shares(c,m,dependencies);
    if(dep){link=link?.dependency?link:{dependency:dep,with:m.id};nearest=Math.min(nearest,d);continue;}
    if(d>g.maxDiameterKm){fits=false;break;}
    if(d<=g.linkKm&&(!Number.isFinite(c.onset)||!Number.isFinite(m.onset)||Math.abs(c.onset-m.onset)<=g.onsetWindowMinutes*60000)){if(!link)link={distanceKm:d,with:m.id};nearest=Math.min(nearest,d);}
   }
   if(!fits||!link)continue;
   const score=[link.dependency?0:1,nearest,Math.min(...cl.members.map(m=>m.onset??Infinity)),cl.members[0].id];
   if(!best||score[0]<best.score[0]||score[0]===best.score[0]&&(score[1]<best.score[1]||score[1]===best.score[1]&&(score[2]<best.score[2]||score[2]===best.score[2]&&score[3]<best.score[3])))best={cl,score,link};
  }
  if(best){best.cl.members.push(c);best.cl.links.push({station:c.id,...best.link});}
  else clusters.push({seedGroupId:null,locked:false,excluded:new Set(),members:[c],links:[]});
 }
 return clusters.map(cl=>{
  const ids=cl.members.map(m=>m.id),pairs=[];for(let i=0;i<cl.members.length;i++)for(let j=i+1;j<cl.members.length;j++)pairs.push(distance(cl.members[i],cl.members[j]));
  const onsets=cl.members.map(m=>m.onset).filter(Number.isFinite);
  return {seedGroupId:cl.seedGroupId,members:ids,links:cl.links,diameterKm:pairs.length?Math.max(...pairs):0,onsetSpanMinutes:onsets.length?Math.round((Math.max(...onsets)-Math.min(...onsets))/60000):null,earliestOnset:onsets.length?Math.min(...onsets):null,latestOnset:onsets.length?Math.max(...onsets):null,belowMinimum:ids.length<g.minGroupSize};
 });
}
