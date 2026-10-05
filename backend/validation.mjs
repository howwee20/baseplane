import {AppError} from './storage.mjs';
export async function parseBody(req,maxBytes=512*1024){
 const length=req.headers.get('Content-Length');
 if(length&&/^\d+$/.test(length)&&Number(length)>maxBytes)throw new AppError('Upload is too large.',413);
 const reader=req.body?.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let total=0,text='';
 if(reader)try{
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw new AppError('Upload is too large.',413);}text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();
 }catch(error){if(error instanceof AppError)throw error;throw new AppError('Invalid JSON request.');}finally{reader.releaseLock();}
 let body;try{body=JSON.parse(text||'{}');}catch{throw new AppError('Invalid JSON request.');}
 if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError('Use a JSON object.');
 return body;
}
export function evidenceInput(b,station){
 const hours=b.hours??24,variable=b.variable??'air_temp',comparisonIds=b.comparisonIds??[];
 const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
 if(!id(station)||![24,72,168].includes(hours)||typeof variable!=='string'||!/^[a-z][a-z0-9_]{0,79}$/.test(variable))throw new AppError('Choose a valid station, variable and history window.');
 if(!Array.isArray(comparisonIds)||comparisonIds.length>5||comparisonIds.some(v=>!id(v)))throw new AppError('Select at most five valid neighboring stations.');
 return {hours,variable,comparisonIds:[...new Set(comparisonIds)]};
}
