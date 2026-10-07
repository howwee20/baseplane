// Canonical priority rules. Every view, export, alert and the planner must order work with comparePriority.
// The key is a lexicographic tuple, never a blended score: no number of minor issues outranks a higher tier.
export const PRIORITY_VERSION='priority-v1';
export const TIERS={
 P1:{rank:1,label:'Group outage',description:'A group of stations is out'},
 P2:{rank:2,label:'Station out',description:'One station is completely out'},
 P3:{rank:3,label:'Multiple sensors',description:'Reporting station with multiple expected sensors missing or down'},
 P4:{rank:4,label:'One sensor',description:'Reporting station with one expected sensor missing or down'},
 QC:{rank:5,label:'Review',description:'Unconfirmed QC or reference anomaly'},
 PM:{rank:6,label:'Maintenance',description:'Preventive or scheduled maintenance'}
};
export const TIE_BREAKERS=['Tier (human override with recorded reason takes precedence)','Confirmed before suspected','Longer outage or issue duration first','More affected stations first','More affected instrument groups first','Higher team-set operational importance first','Weaker nearby reference coverage first','Ready work (confirmed work item, no blocking prerequisites) first','Stable incident identifier'];
// Provisional response deadlines in hours; not adopted policy until the team confirms them.
export const DEFAULT_DEADLINES={P1:24,P2:48,P3:168,P4:336,QC:336,PM:720};
export const effectiveTier=item=>item?.tierOverride?.tier&&TIERS[item.tierOverride.tier]?item.tierOverride.tier:item?.tier;
export const tierRank=t=>TIERS[t]?.rank??99;
const onsetOf=item=>{const t=Date.parse(item.lastGood||item.firstSuspected||item.created||'');return Number.isFinite(t)?t:null;};
export function priorityKey(item,{now=Date.now()}={}){
 const tier=effectiveTier(item),onset=onsetOf(item),duration=onset===null?0:Math.max(0,Math.round((now-onset)/60000));
 return [tierRank(tier),item.confidence==='confirmed'?0:1,-duration,-(item.stationCount||1),-(item.sensorGroupCount||0),-(item.importance||0),-(item.referenceGap||0),item.ready?0:1,String(item.id||'')];
}
export function compareKeys(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i],y=b[i];if(x===y)continue;if(typeof x==='number'&&typeof y==='number')return x-y;return String(x).localeCompare(String(y));}return 0;}
export const comparePriority=(a,b,ctx)=>compareKeys(priorityKey(a,ctx),priorityKey(b,ctx));
export const sortByPriority=(items,ctx)=>[...items].map(item=>({item,key:priorityKey(item,ctx)})).sort((a,b)=>compareKeys(a.key,b.key)).map(x=>x.item);
export function formatDuration(minutes){if(!Number.isFinite(minutes))return 'unknown';if(minutes<60)return `${minutes} min`;if(minutes<2880)return `${Math.floor(minutes/60)} h ${minutes%60} min`;return `${Math.floor(minutes/1440)} d ${Math.floor(minutes%1440/60)} h`;}
export function priorityReasons(item,{now=Date.now()}={}){
 const tier=effectiveTier(item),reasons=[`${tier} · ${TIERS[tier]?.description||'Unclassified'}`];
 if(item.tierOverride?.tier)reasons.push(`Tier set by ${item.tierOverride.by||'a teammate'} from ${item.tier}: ${item.tierOverride.reason}`);
 reasons.push(item.confidence==='confirmed'?'Confirmed by persistence over new snapshots':'Suspected · awaiting confirmation in new snapshots');
 const onset=onsetOf(item);if(onset!==null)reasons.push(`${formatDuration(Math.round((now-onset)/60000))} since last good report`);
 if(item.stationCount>1)reasons.push(`${item.stationCount} stations affected`);
 if(item.sensorGroupCount)reasons.push(`${item.sensorGroupCount} ${item.provisionalGrouping?'provisional instrument group':'instrument group'}${item.sensorGroupCount===1?'':'s'} affected`);
 if(item.importance)reasons.push(`Operational importance ${item.importance}`);
 if(item.referenceGap)reasons.push(`${item.referenceGap} variable${item.referenceGap===1?'':'s'} without defensible nearby references`);
 if(item.ready)reasons.push('Work item ready');
 return reasons;
}
export function deadline(item,deadlines=DEFAULT_DEADLINES){
 const hours=deadlines[effectiveTier(item)],start=Date.parse(item.firstConfirmed||item.firstSuspected||item.created||'');
 return Number.isFinite(hours)&&Number.isFinite(start)?start+hours*36e5:null;
}
