import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('production configuration cannot load synthetic providers or fixture data',()=>{
 const prod=read('../wrangler.jsonc');
 for(const s of ['ROUTING_FIXTURE','dev-worker','synthetic'])assert.equal(prod.includes(s),false,s);
 assert.match(prod,/"main": "worker.mjs"/);
 assert.equal(read('../worker.mjs').includes('dev/'),false);
 assert.match(read('../dev/wrangler.dev.jsonc'),/"database_id":"00000000-0000-0000-0000-000000000000"/);
});
test('frontend and API declare the same operations protocol; Pages builds on hosted Ubuntu runners',()=>{
 assert.match(read('../../web/app.js'),/FRONTEND_PROTOCOL='fleet-ops-1'/);
 assert.match(read('../worker.mjs'),/protocol:'fleet-ops-1'/);
 const wf=read('../../.github/workflows/pages.yml');
 assert.equal(/runs-on: macos/.test(wf),false);assert.match(wf,/timeout-minutes/);assert.match(wf,/fleet-release/);
 const sw=read('../../web/sw.js'),index=read('../../web/index.html');
 for(const asset of index.match(/(?:href|src)="(\/(?:app\.js|styles\.css)[^"]*)"/g).map(x=>x.split('"')[1]))assert.ok(sw.includes(`'${asset}'`),asset);
 assert.equal(/\/api\//.test(sw.match(/ASSETS=\[[^\]]*\]/)[0]),false,'service worker never caches private API responses');
});
