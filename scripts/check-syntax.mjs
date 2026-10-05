import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
function check(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;if(entry.isDirectory()){if(!['node_modules','.wrangler','vendor'].includes(entry.name))check(path);}else if(/\.(mjs|js)$/.test(path)){const result=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}}}
for(const dir of ['web','backend','edge','api','scripts'])check(dir);
