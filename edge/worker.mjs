export function secureResponse(response,path){
 const field=path.startsWith('/field-notes/'),headers=new Headers(response.headers);
 headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://mesonet.agron.iastate.edu https://tile.openstreetmap.org; connect-src 'self' ${field?'https:':'https://enviroweather-fleet-api.polyswap.workers.dev https://mesonet.agron.iastate.edu'}; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'`);
 headers.set('X-Frame-Options','DENY');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');headers.set('Strict-Transport-Security','max-age=31536000');
 if(headers.get('Content-Type')?.includes('text/html')||path==='/sw.js')headers.set('Cache-Control','no-store');
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export default {async fetch(request){const url=new URL(request.url);if(!['atolldb.com','www.atolldb.com'].includes(url.hostname))return secureResponse(new Response('Not found',{status:404}),url.pathname);if(url.protocol!=='https:'){url.protocol='https:';return secureResponse(Response.redirect(url.toString(),301),url.pathname);}if(!['GET','HEAD'].includes(request.method))return secureResponse(new Response('Method not allowed',{status:405}),url.pathname);return secureResponse(await fetch(request,{redirect:'manual',cf:{cacheTtl:0,cacheEverything:false}}),url.pathname);}};
