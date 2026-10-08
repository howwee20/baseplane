// Stamps a built Pages directory so one release is always one consistent set of assets: every relative module
// import, the entry script and stylesheet get ?v=<release>, and the service worker precaches exactly that set.
// Usage: node scripts/stamp-release.mjs _site <release>
import {readdirSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
export function stampModule(source,release){
 const fix=spec=>/^\.{1,2}\//.test(spec)?spec.replace(/\?v=[^'"]*$/,'')+'?v='+release:spec;
 return source
  .replace(/(\bfrom\s*['"])([^'"]+)(['"])/g,(m,a,spec,b)=>a+fix(spec)+b)
  .replace(/(\bimport\s*\(\s*['"])([^'"]+)(['"]\s*\))/g,(m,a,spec,b)=>a+fix(spec)+b)
  .replace(/(^|[;\n]\s*)(import\s*['"])([^'"]+)(['"])/g,(m,pre,a,spec,b)=>pre+a+fix(spec)+b);
}
export function stampHtml(html,release){
 return html.replace(/((?:src|href)=")(\/?(?:[\w./-]+)\.(?:mjs|js|css))(?:\?v=[^"]*)?(")/g,(m,a,path,b)=>/^(https?:)?\/\//.test(path)?m:`${a}${path}?v=${release}${b}`);
}
function walk(dir,out=[]){for(const e of readdirSync(dir)){const p=join(dir,e);if(statSync(p).isDirectory())walk(p,out);else out.push(p);}return out;}
export function stampSite(dir,release){
 if(!/^[a-zA-Z0-9._-]{1,40}$/.test(release))throw Error('Release id must be a short identifier.');
 const files=walk(dir),assets=['/','/index.html','/field-notes/'];
 for(const f of files){
  const rel='/'+relative(dir,f).split('\\').join('/');
  if(/\.(mjs|js)$/.test(f)&&!rel.startsWith('/vendor/')&&rel!=='/sw.js'){writeFileSync(f,stampModule(readFileSync(f,'utf8'),release));}
  if(/\.html$/.test(f))writeFileSync(f,stampHtml(readFileSync(f,'utf8'),release));
  if(/\.(mjs|js|css)$/.test(f)&&rel!=='/sw.js'&&!rel.startsWith('/vendor/leaflet-src'))assets.push(`${rel}?v=${release}`);
  else if(/\.(geojson|png|svg|html)$/.test(f)&&!/sample-logger/.test(f))assets.push(rel);
 }
 const sw=join(dir,'sw.js');
 writeFileSync(sw,readFileSync(sw,'utf8').replace(/const CACHE='[^']*';/,`const CACHE='enviroweather-fleet-${release}';`).replace(/const ASSETS=\[[^\]]*\];/,`const ASSETS=${JSON.stringify([...new Set(assets)])};`));
 return assets.length;
}
if(import.meta.url===`file://${process.argv[1]}`){const [dir,release]=process.argv.slice(2);console.log(`Stamped ${stampSite(dir,release)} assets for release ${release}.`);}
