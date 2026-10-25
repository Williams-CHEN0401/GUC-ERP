// Isolated-test routing only; inaccessible outside the internal Compose network.
import http from 'node:http';
http.createServer((req,res)=>{
 const route=req.url.startsWith('/auth/v1/')?['auth',9999,'/auth/v1']:req.url.startsWith('/rest/v1/')?['rest',3000,'/rest/v1']:null;
 if(!route){res.writeHead(404);return res.end();}
 const upstream=http.request({hostname:route[0],port:route[1],path:req.url.slice(route[2].length),method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
 upstream.on('error',()=>{res.writeHead(502);res.end('Test upstream unavailable');});req.pipe(upstream);
}).listen(8000,'0.0.0.0');
