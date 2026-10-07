// Time helpers for America/Detroit. Instants are stored as UTC ISO strings or epoch milliseconds;
// local wall-clock values are converted here so DST gaps and repeated hours are explicit.
export const ZONE='America/Detroit';
const formatters=new Map();
function formatter(zone){
 if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short'}));
 return formatters.get(zone);
}
const WEEKDAYS={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7};
export function zonedParts(ms,zone=ZONE){
 const p=Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
 return {year:+p.year,month:+p.month,day:+p.day,hour:+p.hour,minute:+p.minute,second:+p.second,weekday:WEEKDAYS[p.weekday]};
}
export function offsetMinutes(ms,zone=ZONE){const p=zonedParts(ms,zone);return Math.round((Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(ms/1000)*1000)/60000);}
export const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
export const validTime=s=>typeof s==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(s);
// Converts a local wall-clock time to UTC. Nonexistent times (spring-forward gap) move forward by the gap;
// repeated times (fall-back hour) resolve to the first occurrence. Both cases are flagged.
export function localToUtc(date,time,zone=ZONE){
 if(!validDate(date)||!validTime(time))throw Error('Use YYYY-MM-DD dates and HH:MM times.');
 const [y,m,d]=date.split('-').map(Number),[hh,mm]=time.split(':').map(Number),naive=Date.UTC(y,m-1,d,hh,mm);
 const candidates=[...new Set([offsetMinutes(naive-36e5*12,zone),offsetMinutes(naive,zone),offsetMinutes(naive+36e5*12,zone)])]
  .map(off=>naive-off*60000).filter(ms=>{const p=zonedParts(ms,zone);return p.year===y&&p.month===m&&p.day===d&&p.hour===hh&&p.minute===mm;}).sort((a,b)=>a-b);
 if(candidates.length)return {ms:candidates[0],ambiguous:candidates.length>1,skipped:false};
 const before=offsetMinutes(naive-36e5*12,zone),after=offsetMinutes(naive+36e5*12,zone);
 return {ms:naive-before*60000,ambiguous:false,skipped:true,shiftMinutes:after-before};
}
export function localDate(ms,zone=ZONE){const p=zonedParts(ms,zone);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
export function localTime(ms,zone=ZONE){const p=zonedParts(ms,zone);return `${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`;}
export function addDays(date,n){const t=new Date(date+'T12:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);}
export const weekday=date=>{const d=new Date(date+'T12:00:00Z').getUTCDay();return d===0?7:d;};
export function dayBounds(date,zone=ZONE){return {start:localToUtc(date,'00:00',zone).ms,end:localToUtc(addDays(date,1),'00:00',zone).ms};}
export function formatLocal(ms,zone=ZONE,options={}){return Number.isFinite(ms)?new Date(ms).toLocaleString('en-US',{timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',...options}):'Unavailable';}
export function zoneAbbreviation(ms,zone=ZONE){return new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'short'}).formatToParts(new Date(ms)).find(p=>p.type==='timeZoneName')?.value||'';}
export function parseInstant(v){if(typeof v==='number')return Number.isFinite(v)?v:null;if(typeof v!=='string'||!v)return null;
 // Synoptic sometimes returns compact YYYYMMDDHHMM UTC stamps for derived values.
 const compact=v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);if(compact)return Date.UTC(+compact[1],compact[2]-1,+compact[3],+compact[4],+compact[5]);
 const t=Date.parse(v);return Number.isFinite(t)?t:null;}

// NOAA solar-position approximation (±2 minutes at Michigan latitudes) for daylight checks.
export function sunTimes(date,lat,lon){
 if(!validDate(date)||!Number.isFinite(lat)||!Number.isFinite(lon))return null;
 const rad=Math.PI/180,noonUtc=Date.UTC(...date.split('-').map((v,i)=>i===1?v-1:+v),12);
 const jd=noonUtc/864e5+2440587.5-lon/360,n=jd-2451545.0+0.0008;
 const M=(357.5291+0.98560028*n)%360,C=1.9148*Math.sin(M*rad)+0.02*Math.sin(2*M*rad)+0.0003*Math.sin(3*M*rad);
 const L=(M+C+180+102.9372)%360,transit=2451545+n+0.0053*Math.sin(M*rad)-0.0069*Math.sin(2*L*rad);
 const dec=Math.asin(Math.sin(L*rad)*Math.sin(23.4397*rad)),cosH=(Math.sin(-0.833*rad)-Math.sin(lat*rad)*Math.sin(dec))/(Math.cos(lat*rad)*Math.cos(dec));
 if(cosH>1)return {polarNight:true};if(cosH<-1)return {midnightSun:true};
 const H=Math.acos(cosH)/rad/360,toMs=j=>Math.round((j-2440587.5)*864e5);
 return {sunrise:toMs(transit-H),sunset:toMs(transit+H),solarNoon:toMs(transit)};
}
export function isDaylight(ms,lat,lon,zone=ZONE){const s=sunTimes(localDate(ms,zone),lat,lon);return s?.sunrise?ms>=s.sunrise&&ms<=s.sunset:null;}
