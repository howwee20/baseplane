// Hash routes for the map-first shell. Every older deep link resolves to its new destination.
export const REDIRECTS={'#/':'#/map','#/overview':'#/map','#/review':'#/attention','#/alerts':'#/attention/changes','#/anomalies':'#/records/references','#/tracker':'#/records/tracker','#/stations':'#/records/stations','#/planner':'#/trips/compare','#/plans':'#/trips','#/issues':'#/records/investigations','#/visits':'#/records/visits','#/bench':'#/tools/logger','#/connections':'#/settings','#/records':'#/records/investigations'};
export function parseRoute(hash){
 let h;try{h=decodeURIComponent(hash||'');}catch{h='#/map';}if(!h.startsWith('#/'))h='#/map';
 if(REDIRECTS[h])return {redirect:REDIRECTS[h]};
 let m;
 if(m=h.match(/^#\/plan\/([a-f0-9-]{36})$/))return {redirect:'#/trip/'+m[1]};
 if(h==='#/map')return {dest:'map'};
 if(m=h.match(/^#\/station\/([A-Za-z0-9_-]{1,100})\/details$/))return {dest:'map',page:'station',id:m[1]};
 if(m=h.match(/^#\/station\/([A-Za-z0-9_-]{1,100})$/))return {dest:'map',panel:'station',id:m[1]};
 if(m=h.match(/^#\/attention(?:\/(qc|changes))?$/))return {dest:'map',panel:'attention',tab:m[1]||'issues'};
 if(m=h.match(/^#\/incident\/([a-f0-9-]{36})$/))return {dest:'map',page:'incident',id:m[1]};
 if(h==='#/trips')return {dest:'trips',panel:'trips',view:'list'};
 if(h==='#/trips/new')return {dest:'trips',panel:'trips',view:'edit'};
 if(h==='#/trips/compare')return {dest:'trips',page:'planner'};
 if(m=h.match(/^#\/trip\/([a-f0-9-]{36})$/))return {dest:'trips',panel:'trips',view:'trip',id:m[1]};
 if(m=h.match(/^#\/packet\/([a-f0-9-]{36})$/))return {dest:'trips',page:'packet',id:m[1]};
 if(m=h.match(/^#\/records\/(investigations|visits|stations|references|tracker)$/))return {dest:'records',page:'records',tab:m[1]};
 if(m=h.match(/^#\/(account|team|settings)$/))return {dest:'admin',page:m[1]};
 if(h==='#/tools/logger')return {dest:'admin',page:'logger'};
 return {redirect:'#/map'};
}
