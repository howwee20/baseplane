import {Buffer} from 'node:buffer';
export class AppError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export async function readDoc(db,key){
 const {results}=await db.prepare('SELECT d.updated,d.revision,c.data FROM documents d JOIN chunks c ON c.key=d.key AND c.revision=d.revision WHERE d.key=? ORDER BY c.part').bind(key).all();if(!results.length)return null;
 return {body:JSON.parse(Buffer.concat(results.map(r=>Buffer.from(r.data,'base64'))).toString('utf8')),at:results[0].updated,revision:results[0].revision};
}
export async function saveDoc(db,key,type,body,summary={},expected){
 const raw=Buffer.from(JSON.stringify(body));if(raw.length>24*1024*1024)throw new AppError('This record is too large. Export the existing case and start a follow-up case.',413);
 const previous=expected||(await db.prepare('SELECT revision FROM documents WHERE key=?').bind(key).first())?.revision;
 const revision=crypto.randomUUID(),now=new Date().toISOString(),statements=[];
 for(let i=0,part=0;i<raw.length;i+=131072,part++)statements.push(db.prepare('INSERT INTO chunks (key,revision,part,data) VALUES(?,?,?,?)').bind(key,revision,part,raw.subarray(i,i+131072).toString('base64')));
 const station=summary.station||null,status=summary.status||null;
 if(expected)statements.push(db.prepare('UPDATE documents SET type=?,station=?,status=?,revision=?,updated=?,summary=? WHERE key=? AND revision=?').bind(type,station,status,revision,now,JSON.stringify(summary),key,expected));
 else statements.push(db.prepare('INSERT INTO documents (key,type,station,status,revision,created,updated,summary) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET type=excluded.type,station=excluded.station,status=excluded.status,revision=excluded.revision,updated=excluded.updated,summary=excluded.summary').bind(key,type,station,status,revision,summary.created||now,now,JSON.stringify(summary)));
 let results;try{results=await db.batch(statements);}catch(e){if(String(e).includes('UNIQUE'))throw new AppError('An open investigation already exists for this station. Reload to see it.',409);throw e;}
 if(expected&&results.at(-1).meta.changes!==1){await db.prepare('DELETE FROM chunks WHERE key=? AND revision=?').bind(key,revision).run();throw new AppError('Someone updated this record. Your entries are still open; reload the record before saving.',409);}
 if(previous)await db.prepare('DELETE FROM chunks WHERE key=? AND revision=?').bind(key,previous).run();return revision;
}
export async function summaries(db,types){const marks=types.map(()=>'?').join(',');const {results}=await db.prepare(`SELECT summary FROM documents WHERE type IN (${marks}) ORDER BY updated DESC LIMIT 1000`).bind(...types).all();return results.map(r=>JSON.parse(r.summary));}
export function recordSummary(r){const {evidence,photos,...rest}=r;return {...rest,evidenceCount:evidence?.length||0,photoCount:photos?.length||0};}
