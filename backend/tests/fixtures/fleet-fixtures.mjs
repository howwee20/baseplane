// SYNTHETIC FIXTURES ONLY. Station identifiers (TST..), names, coordinates and readings are invented for tests
// and must never be presented as live operational evidence.
export const T0=Date.parse('2026-10-07T14:00:00Z');
const lonPerKm=1/81.4;// at about 43° N
export const CHANNELS=[
 ['air_temp','1','1.5',5],['relative_humidity','1','1.5',5],['wind_speed','1','3.0',60],['wind_gust','1','3.0',60],['wind_direction','1','3.0',60],
 ['solar_radiation','1','2.0',60],['precip_accum_one_hour','1','1.0',60],['precip_accum_five_minute','1','1.0',5],['soil_temp','1','-0.05',60],['soil_moisture','1','-0.05',60],['volt','1','1.0',60]
];
export const UNITS={air_temp:'Celsius',relative_humidity:'%',wind_speed:'m/s',wind_gust:'m/s',wind_direction:'Degrees',solar_radiation:'W/m**2',precip_accum_one_hour:'Millimeters',precip_accum_five_minute:'Millimeters',soil_temp:'Celsius',soil_moisture:'%',volt:'volts'};
export function station(i,{xKm=i*60,yKm=0,status='ACTIVE',extra=[],never=[],dormant=[]}={}){
 const id='TST'+String(i).padStart(2,'0'),vars={};
 for(const [v,n,pos] of [...CHANNELS,...extra]){(vars[v]??={})[`${v}_${n}`]={position:pos,PERIOD_OF_RECORD:{start:'2020-01-01T00:00:00Z',end:new Date(T0).toISOString()}};}
 for(const [v,n,pos] of never)(vars[v]??={})[`${v}_${n}`]={position:pos,PERIOD_OF_RECORD:{start:null,end:null}};
 for(const [v,n,pos] of dormant)(vars[v]??={})[`${v}_${n}`]={position:pos,PERIOD_OF_RECORD:{start:'2020-01-01T00:00:00Z',end:'2026-06-01T00:00:00Z'}};
 return {STID:id,NAME:'Synthetic '+id,LATITUDE:String(43+yKm/111),LONGITUDE:String(-85+xKm*lonPerKm),STATUS:status,ELEVATION:'800',SENSOR_VARIABLES:vars};
}
const VALUES={air_temp:12.5,relative_humidity:70,wind_speed:0,wind_gust:0,wind_direction:180,solar_radiation:0,precip_accum_one_hour:0,precip_accum_five_minute:0,soil_temp:14,soil_moisture:20,volt:12.8};
// obsAt: ms of newest observation; drop: channel names omitted; nulls: channels returned with null value.
export function observe(meta,{obsAt=T0-10*60000,drop=[],nulls=[],lag={},qc={},future=[],values={}}={}){
 const o={};
 for(const [v,chs] of Object.entries(meta.SENSOR_VARIABLES))for(const [ch,info] of Object.entries(chs)){
  if(!info.PERIOD_OF_RECORD.start||drop.includes(ch))continue;
  if(info.PERIOD_OF_RECORD.end&&Date.parse(info.PERIOD_OF_RECORD.end)<T0-30*864e5)continue;
  const key=ch.replace(/_(\d+)$/,'_value_$1'),t=future.includes(ch)?T0+3600000:obsAt-(lag[ch]||0)*60000;
  o[key]={value:nulls.includes(ch)?null:values[ch]??VALUES[v],date_time:new Date(t).toISOString(),qc:qc[ch]?{status:'failed',qc_flags:qc[ch]}:{status:'passed'}};
 }
 o.dew_point_temperature_value_1d={value:7.1,date_time:new Date(obsAt).toISOString()};
 return {...meta,OBSERVATIONS:o};
}
export function snapshot(metas,perStation={},{omit=[]}={}){
 return {metadata:{STATION:metas},latest:{STATION:metas.filter(m=>!omit.includes(m.STID)).map(m=>perStation[m.STID]===null?{...m,OBSERVATIONS:{}}:observe(m,perStation[m.STID]||{})),UNITS}};
}
