// LOCAL REVIEW ONLY. Copies a read-only snapshot of production D1 into the local review database so the UI can be
// exercised with real stations, observations and incidents. Users, sessions, invitations and rate-limit rows are never
// copied; create a local test owner instead. Writes made while reviewing stay in the local database.
// Usage (from backend/): node dev/seed-from-production.mjs   then   npm run dev:copy
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const wrangler=(args)=>{const r=spawnSync('./node_modules/.bin/wrangler',args,{encoding:'utf8',maxBuffer:256*1024*1024});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout;};
const remote=sql=>JSON.parse(wrangler(['d1','execute','enviroweather-fleet','--remote','--json','--command',sql]))[0].results;
// Local D1 rejects statements over 100 KB, so rows are written to the local SQLite file with bound parameters.
wrangler(['d1','execute','enviroweather-fleet-local','--local','--config','dev/wrangler.local.jsonc','--command','CREATE TABLE IF NOT EXISTS _local_copy_marker(x INTEGER)']);
const root='dev/.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const file=readdirSync(root).filter(f=>f.endsWith('.sqlite')&&f!=='metadata.sqlite').map(f=>join(root,f)).find(f=>{const d=new DatabaseSync(f);try{return !!d.prepare("SELECT 1 FROM sqlite_master WHERE name='_local_copy_marker'").get();}finally{d.close();}});
if(!file)throw Error('Local review database not found; run migrations for dev/wrangler.local.jsonc first.');
const db=new DatabaseSync(file);
const put=(table,rows)=>{for(const r of rows){const k=Object.keys(r);db.prepare(`INSERT OR REPLACE INTO ${table}(${k.join(',')}) VALUES(${k.map(()=>'?').join(',')})`).run(...Object.values(r));}return rows.length;};
const docTypes="('cache','settings','issue','bench','investigation','visit')";
const docs=remote(`SELECT * FROM documents WHERE type IN ${docTypes} AND key NOT LIKE 'cache:history:%' AND key NOT LIKE 'cache:product:%'`);
db.exec('BEGIN');
put('documents',docs);
for(const d of docs)put('chunks',remote(`SELECT * FROM chunks WHERE key='${d.key.replaceAll("'","''")}' AND revision='${d.revision}'`));
const counts={};
for(const t of ['incidents','incident_events','alerts','fleet_blobs','work_items','plans','plan_revisions','station_notes','reference_overrides'])counts[t]=put(t,remote(`SELECT * FROM ${t}`));
counts.ingests=put('ingests',remote('SELECT * FROM ingests ORDER BY retrieved_at DESC LIMIT 12'));
db.exec('COMMIT');db.close();
console.log(`Copied ${docs.length} documents and ${JSON.stringify(counts)} into the local review database (no users or sessions).`);
