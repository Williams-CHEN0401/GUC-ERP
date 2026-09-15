import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
const {server}=await createWorklogTestServer({workflow:true});
server.listen(4200,'127.0.0.1',()=>console.log('ERP workflow isolated test: http://127.0.0.1:4200/?page=worklogs'));
