import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {seedIndependent} from './independent-work-fixture.mjs';
const {server,db}=await createWorklogTestServer({independent:true});
await seedIndependent(db);
const port=Number(process.env.WORKLOG_TEST_PORT||4213);
server.listen(port,'127.0.0.1',()=>console.log('隔離資料庫：http://127.0.0.1:'+port+'/?page=inventory'));
