import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
const {server}=await createWorklogTestServer({assignments:true});
const port=Number(process.env.ASSIGNMENT_TEST_PORT||4201);
server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port+'/?page=dashboard — isolated assignment DB only'));
