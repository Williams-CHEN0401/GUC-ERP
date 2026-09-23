import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {seedIndependent} from './independent-work-fixture.mjs';
const {server,db}=await createWorklogTestServer({formSync:true});
await seedIndependent(db);
const port=Number(process.env.WORKLOG_TEST_PORT||4214);
server.listen(port,'127.0.0.1',()=>console.log('隔離資料庫：http://127.0.0.1:'+port+'/?page=transactions — 使用 test_user=B 可用第二位合成使用者'));
