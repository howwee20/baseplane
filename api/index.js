export default function retiredAtollApi(request,response){
 response.statusCode=410;
 response.setHeader('Content-Type','application/json; charset=utf-8');
 response.setHeader('Cache-Control','no-store');
 response.setHeader('X-Content-Type-Options','nosniff');
 return response.end(JSON.stringify({error:'legacy_api_retired',message:'The old Atoll database service has been retired. Use https://atolldb.com for Enviroweather Fleet.'}));
}
