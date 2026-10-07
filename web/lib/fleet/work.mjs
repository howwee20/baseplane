// Maintenance work items. Templates propose tasks; they never record readings or mark work performed.
// Durations are explicit estimates with uncertainty. Manufacturer procedures and MSU practice govern technical work.
export const WORK_VERSION='work-v1';
export const WORK_STATUSES=['proposed','confirmed','planned','in_progress','awaiting_parts','awaiting_access','done','cancelled'];
export const TECH_NOTE='Templates are prompts for planning, not procedures. Follow manufacturer documentation and MSU practice.';
export const TEMPLATES={
 'remote-check':{label:'Remote investigation (before any visit)',taskClass:'inspection',onSite:false,estimateMinutes:0,uncertaintyMinutes:0,skills:[],tasks:['Check the data-service status and whether neighbouring networks also stopped reporting','Check whether affected stations share a known modem, carrier, repeater or power feed (not inferred by Fleet)','Attempt remote logger contact if a supported method exists','Decide which stations need a site visit and record why'],parts:[],tools:[]},
 'comms-power':{label:'Communications / power investigation',taskClass:'electronics',onSite:true,estimateMinutes:60,uncertaintyMinutes:30,skills:['electronics'],tasks:['Inspect logger status and display','Check battery voltage, charge regulator and solar panel','Check modem/radio power, signal and antenna cabling','Retrieve logger data covering the telemetry gap','Confirm transmission resumes after work (recovery is verified later from telemetry)'],parts:['Spare battery (if stocked)','Fuses','Spare modem/radio (if stocked)'],tools:['Multimeter','Laptop with logger software','Cable kit']},
 'sensor-inspection':{label:'Sensor inspection',taskClass:'electronics',onSite:true,estimateMinutes:45,uncertaintyMinutes:30,skills:['electronics'],tasks:['Inspect the affected sensor, cable and connections','Check wiring and terminal readings at the logger','Compare against a reference instrument where available','Replace only if confirmed faulty (manufacturer procedure)'],parts:['Replacement sensor (confirm model and calibration date)'],tools:['Multimeter','Reference instrument','Hand tools']},
 'tower-sensor':{label:'Tower-mounted sensor inspection',taskClass:'exposed',onSite:true,estimateMinutes:75,uncertaintyMinutes:45,skills:['electronics','tower'],tasks:['Inspect the mast-mounted sensor and cable run','Check mounting, alignment and connector','Replace only if confirmed faulty (manufacturer procedure)'],parts:['Replacement sensor (confirm model)'],tools:['Ladder or tower equipment per MSU practice','Hand tools','Multimeter']},
 'vegetation':{label:'Vegetation / obstruction check',taskClass:'inspection',onSite:true,estimateMinutes:30,uncertaintyMinutes:20,skills:[],tasks:['Check vegetation or obstructions around the rain gauge, pyranometer and wind sensor','Clear or trim if permitted at the site','Photograph site exposure before and after'],parts:[],tools:['Trimmer','Camera']},
 'scheduled-service':{label:'Scheduled service',taskClass:'exposed',onSite:true,estimateMinutes:90,uncertaintyMinutes:30,skills:['electronics'],tasks:['Clean the rain-gauge funnel and check the tipping mechanism','Level and clean the pyranometer','Inspect the temperature/RH radiation shield','Inspect mast, guy wires and enclosure','Swap sensors due for calibration per schedule'],parts:['Calibration-swap sensors (per schedule)'],tools:['Level','Cleaning kit','Hand tools']}
};
// Suggests templates for an incident without assuming a cause.
export function suggestTemplates(incident){
 if(!incident)return ['scheduled-service'];
 if(incident.scope==='group')return ['remote-check','comms-power'];
 if(incident.kind==='outage')return ['comms-power','remote-check'];
 const groups=incident.body?.sensorGroups||[],tall=groups.some(g=>/^wind@/.test(g.id)&&Number(g.id.split('@')[1])>=3);
 const out=[tall?'tower-sensor':'sensor-inspection'];if(groups.some(g=>/^(rain|pyranometer)@/.test(g.id)))out.push('vegetation');return out;
}
const str=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const list=(v,max,len)=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.trim()).slice(0,max).map(x=>x.trim().slice(0,len)):[];
export function validateWindows(v){
 if(v===undefined||v===null)return null;
 if(!Array.isArray(v)||v.length>14)throw Error('Use up to 14 access windows.');
 return v.map(w=>{const days=Array.isArray(w.days)?[...new Set(w.days)].filter(d=>Number.isInteger(d)&&d>=1&&d<=7):[];if(!days.length||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)||w.end<=w.start)throw Error('Access windows need weekdays (1=Mon…7=Sun) and HH:MM start/end.');return {days:days.sort(),start:w.start,end:w.end};});
}
export function newWorkItem(input,{incident=null,actor='',now=new Date().toISOString()}={}){
 const t=TEMPLATES[input.template]||null;if(input.template&&!t)throw Error('Choose a supported work template.');
 const station=str(input.station,100);if(!/^[A-Za-z0-9_-]{1,100}$/.test(station))throw Error('Choose a station.');
 const est=input.estimateMinutes??t?.estimateMinutes??null,unc=input.uncertaintyMinutes??t?.uncertaintyMinutes??null;
 if(est!==null&&!(Number.isInteger(est)&&est>=0&&est<=720))throw Error('Estimated on-site time must be 0–720 minutes.');
 if(unc!==null&&!(Number.isInteger(unc)&&unc>=0&&unc<=480))throw Error('Uncertainty must be 0–480 minutes.');
 const taskClass=input.taskClass||t?.taskClass||'electronics';if(!['electronics','exposed','inspection'].includes(taskClass))throw Error('Choose a task-weather class.');
 return {id:crypto.randomUUID(),version:WORK_VERSION,incidentId:incident?.id||null,station,status:'proposed',template:input.template||null,title:str(input.title,200)||t?.label||'Station work',
  reason:str(input.reason,2000)||(incident?.body?.reasons||[]).join(' ').slice(0,2000),evidence:incident?{incidentId:incident.id,tier:incident.tier,capturedAt:now,reasons:incident.body?.reasons||[],channels:incident.body?.channels||[],lastGood:incident.lastGood||null}:null,
  proposedTasks:list(input.proposedTasks??t?.tasks,30,300),confirmedTasks:[],estimateMinutes:est,uncertaintyMinutes:unc,estimateBasis:est===null?'unknown':input.estimateMinutes!==undefined?'entered':'template default (unconfirmed)',
  onSite:input.onSite??t?.onSite??true,taskClass,parts:list(input.parts??t?.parts,30,200),tools:list(input.tools??t?.tools,30,200),skills:list(input.skills??t?.skills,10,40),crewSize:Number.isInteger(input.crewSize)&&input.crewSize>=1&&input.crewSize<=6?input.crewSize:null,
  accessWindows:validateWindows(input.accessWindows),prerequisites:list(input.prerequisites,20,300),assignee:str(input.assignee,100)||null,
  recoveryCriteria:str(input.recoveryCriteria,500)||'Affected channels report again in consecutive new snapshots (verified from telemetry, not from work completion).',
  workPerformed:null,activity:[{at:now,actor,action:'Work item created',status:'proposed'}],note:TECH_NOTE};
}
export function applyWorkPatch(w,b,{actor='',now=new Date().toISOString()}={}){
 const next=structuredClone(w),changes=[];
 if(b.status!==undefined){if(!WORK_STATUSES.includes(b.status))throw Error('Choose a supported work status.');if(b.status==='done'&&!str(b.workPerformed?.summary??next.workPerformed?.summary,2000))throw Error('Record the work actually performed before marking it done.');if(b.status!==next.status){changes.push(`${next.status} → ${b.status}`);next.status=b.status;}}
 for(const [k,max] of [['title',200],['reason',2000],['recoveryCriteria',500]])if(b[k]!==undefined){next[k]=str(b[k],max);changes.push(k);}
 if(b.assignee!==undefined){next.assignee=str(b.assignee,100)||null;changes.push('assignee');}
 for(const [k,max,len] of [['proposedTasks',30,300],['confirmedTasks',30,300],['parts',30,200],['tools',30,200],['skills',10,40],['prerequisites',20,300]])if(b[k]!==undefined){next[k]=list(b[k],max,len);changes.push(k);}
 if(b.estimateMinutes!==undefined){if(b.estimateMinutes!==null&&!(Number.isInteger(b.estimateMinutes)&&b.estimateMinutes>=0&&b.estimateMinutes<=720))throw Error('Estimated on-site time must be 0–720 minutes.');next.estimateMinutes=b.estimateMinutes;next.estimateBasis=b.estimateMinutes===null?'unknown':'entered';changes.push('estimate');}
 if(b.uncertaintyMinutes!==undefined){if(b.uncertaintyMinutes!==null&&!(Number.isInteger(b.uncertaintyMinutes)&&b.uncertaintyMinutes>=0&&b.uncertaintyMinutes<=480))throw Error('Uncertainty must be 0–480 minutes.');next.uncertaintyMinutes=b.uncertaintyMinutes;changes.push('uncertainty');}
 if(b.taskClass!==undefined){if(!['electronics','exposed','inspection'].includes(b.taskClass))throw Error('Choose a task-weather class.');next.taskClass=b.taskClass;changes.push('taskClass');}
 if(b.accessWindows!==undefined){next.accessWindows=validateWindows(b.accessWindows);changes.push('accessWindows');}
 if(b.workPerformed!==undefined){const s=str(b.workPerformed?.summary,2000);next.workPerformed=s?{summary:s,performedAt:str(b.workPerformed.performedAt,40)||now,recordedBy:actor,visitId:str(b.workPerformed.visitId,100)||null}:null;changes.push('workPerformed');}
 if(!changes.length)throw Error('No changes to save.');
 next.activity=[...(next.activity||[]).slice(-99),{at:now,actor,action:'Updated: '+changes.join(', '),status:next.status}];
 return {item:next,summary:changes.join(', ')};
}
// Field Notes handoff in the existing schema (enviroweather-field-handoff v1) so saved notebooks stay compatible.
export function workHandoff(w,{stationName='',now=new Date().toISOString()}={}){
 const tasks=w.confirmedTasks?.length?w.confirmedTasks:w.proposedTasks||[];
 return {schemaVersion:1,kind:'enviroweather-field-handoff',exportedAt:now,case:{id:w.id,title:w.title,station:w.station,status:w.status,notes:w.reason,created:w.created,updated:w.updated,activity:w.activity||[]},evidence:w.evidence?[w.evidence]:[],
  visit:{stationId:w.station,stationName:stationName||w.station,reason:w.reason||w.title,plannedChecks:tasks.map(t=>(w.confirmedTasks?.length?'':'(proposed) ')+t)},
  limitations:['Planned work only. Readings, arrival time and performed-work checks are left blank for the field team.','Completing work does not prove telemetry recovery; recovery is verified from later snapshots.',TECH_NOTE]};
}
