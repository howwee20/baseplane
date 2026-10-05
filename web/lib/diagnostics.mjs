export function numeric(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
export function qcFlags(qc) { return Array.isArray(qc) ? qc : Array.isArray(qc?.qc_flags) ? qc.qc_flags : []; }
export function observationFields(station, units = {}) {
  return Object.entries(station.OBSERVATIONS || {}).filter(([,v])=>v && typeof v==='object' && !Array.isArray(v) && 'value' in v).map(([key,v])=>{
    const variable=key.replace(/_value_\d+.*/, '');
    return {key,variable,value:v.value,time:v.date_time||null,unit:units[variable]||'',qc:qcFlags(v.qc),qcStatus:v.qc?.status||null,derived:/d$/.test(key)};
  });
}
export function assess(station,units={},now=Date.now(),thresholds={delayed:60,stale:180}) {
  const fields=observationFields(station,units);
  const timestamps=fields.filter(f=>!f.derived&&numeric(f.value)!==null).map(f=>Date.parse(f.time)).filter(Number.isFinite);
  const last=timestamps.length?Math.max(...timestamps):null;
  const age=last===null?null:(now-last)/60000;
  const flagged=station.QC_FLAGGED===true || fields.some(f=>f.qc.length>0||f.qcStatus==='failed');
  let status='reporting';
  if(station.STATUS==='INACTIVE')status='inactive';
  else if(age===null)status='unknown';
  else if(age < -5)status='clock';
  else if(age>thresholds.stale)status='stale';
  else if(age>thresholds.delayed)status='delayed';
  else if(flagged)status='qc';
  const finiteCoordinate=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
  return {id:station.STID,name:station.NAME||station.STID,lat:finiteCoordinate(station.LATITUDE),lon:finiteCoordinate(station.LONGITUDE),state:station.STATE,network:station.MNET_ID,archiveStatus:station.STATUS,status,last:last===null?null:new Date(last).toISOString(),ageMinutes:age===null?null:Math.max(0,Math.round(age)),flagged,fields,period:station.PERIOD_OF_RECORD,timezone:station.TIMEZONE,sensors:station.SENSOR_VARIABLES||{},restricted:!!station.RESTRICTED};
}
export function parseCSV(text) {
  const rows=[];let row=[],cell='',quote=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(c===','&&!quote){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quote){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
  if(quote)throw new Error('Unclosed quoted field in CSV.');
  if(cell||row.length){row.push(cell);rows.push(row);}
  return rows;
}
export function analyzeCSV(text) {
  const rows=parseCSV(text.replace(/^\uFEFF/,''));
  if(rows.length<2)throw new Error('The file needs a header and data rows.');
  const toa5=rows[0][0]==='TOA5',header=toa5?rows[1]:rows[0],data=rows.slice(toa5?4:1),units=toa5?rows[2]:[];
  if(!header?.length||data.length===0)throw new Error('No observations found.');
  if(header.length>200||data.length>100000)throw new Error('Limit: 200 columns and 100,000 rows per file.');
  const timeIndex=header.findIndex(x=>/^(timestamp|date_time|datetime|time)$/i.test(x.trim()));
  const recordIndex=header.findIndex(x=>/^record$/i.test(x));
  const stats=header.map((name,col)=>{let values=[],missing=0;for(const r of data){const s=(r[col]??'').trim();if(!s||/^(nan|null|n\/a|inf|-inf)$/i.test(s)){missing++;continue;}const n=Number(s);if(Number.isFinite(n))values.push(n);}
    return {name,unit:units[col]||'',count:values.length,missing,min:values.length?Math.min(...values.slice(0,100000)):null,max:values.length?Math.max(...values.slice(0,100000)):null,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,constant:values.length>1&&values.every(v=>v===values[0])};});
  let duplicateTimes=0,reverseTimes=0,recordResets=0;const seen=new Set();let prev=null,prevRecord=null;const intervals=[];
  for(const r of data){if(timeIndex>=0){const ts=r[timeIndex];if(seen.has(ts))duplicateTimes++;seen.add(ts);const n=Date.parse(ts);if(Number.isFinite(n)){if(prev!==null){const d=(n-prev)/1000;if(d<0)reverseTimes++;else if(d>0)intervals.push(d);}prev=n;}}
    if(recordIndex>=0&&r[recordIndex]?.trim()){const n=Number(r[recordIndex]);if(Number.isFinite(n)){if(prevRecord!==null&&n<prevRecord)recordResets++;prevRecord=n;}}}
  const sorted=[...intervals].sort((a,b)=>a-b),median=sorted.length?sorted[Math.floor(sorted.length/2)]:null;
  return {format:toa5?'Campbell TOA5':'CSV',logger:toa5?{station:rows[0][1],model:rows[0][2],serial:rows[0][3],os:rows[0][4],program:rows[0][5],table:rows[0][7]}:null,rows:data.length,columns:header.length,malformedRows:data.filter(r=>r.length!==header.length).length,start:timeIndex>=0?data[0][timeIndex]:null,end:timeIndex>=0?data.at(-1)[timeIndex]:null,timeNote:'File timestamps are shown as recorded. No timezone is assumed.',duplicateTimes,reverseTimes,recordResets,medianIntervalSeconds:median,gaps:median?intervals.filter(d=>d>median*1.5).length:0,stats,sample: data.filter((_,i)=>i%Math.max(1,Math.ceil(data.length/500))===0).map(r=>Object.fromEntries(header.map((h,i)=>[h,r[i]??'']))),header,timeColumn:timeIndex>=0?header[timeIndex]:null};
}
