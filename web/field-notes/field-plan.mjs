export function parseVisitPlan(value){
 if(!value||value.schemaVersion!==1||value.kind!=='enviroweather-field-handoff'||!value.visit)throw Error('Choose an Enviroweather visit-plan JSON file.');
 const str=(v,max=10000)=>typeof v==='string'?v.slice(0,max):'';
 const plan={stationId:str(value.visit.stationId,100),stationName:str(value.visit.stationName,200),reason:str(value.visit.reason),plannedChecks:Array.isArray(value.visit.plannedChecks)?value.visit.plannedChecks.filter(x=>typeof x==='string').slice(0,50).map(x=>x.slice(0,500)):typeof value.visit.plannedChecks==='string'?value.visit.plannedChecks.split(/\r?\n/).filter(x=>x.trim()).slice(0,50).map(x=>x.slice(0,500)):[],caseId:str(value.case?.id,100),exportedAt:str(value.exportedAt,100),limitations:Array.isArray(value.limitations)?value.limitations.filter(x=>typeof x==='string').slice(0,20).map(x=>x.slice(0,1000)):[]};
 if(!plan.stationName&&!plan.stationId)throw Error('The visit plan does not identify a station.');return plan;
}
export function applyVisitPlan(visit,plan){
 if((plan.stationName&&String(visit.fields.siteName??'').trim()&&visit.fields.siteName.trim().toLowerCase()!==plan.stationName.trim().toLowerCase())||(plan.stationId&&String(visit.fields.siteId??'').trim()&&visit.fields.siteId.trim()!==plan.stationId))throw Error('This sheet names another station. Start a new visit before importing the plan.');
 visit.fields.siteName ||= plan.stationName;visit.fields.siteId ||= plan.stationId;
 const note=['Visit plan from Enviroweather',plan.caseId?`Case: ${plan.caseId}`:'',plan.reason,...plan.plannedChecks.map(x=>`Planned: ${x}`),...plan.limitations.map(x=>`Limit: ${x}`)].filter(Boolean).join('\n');
 visit.fields.observations=[visit.fields.observations,note].filter(Boolean).join('\n\n');visit.visitPlan={...plan,importedAt:new Date().toISOString()};return visit;
}
