import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {sample,saveLog} from './worklog-save-fixture.mjs';
const {server,db}=await createWorklogTestServer({dailyTypes:true});
await saveLog(db,{...sample(),project_name:'跨日工作類型測試',work_type:'工程施工',maintenance_events:[]});
const port=Number(process.env.WORKLOG_TEST_PORT||4212);
server.listen(port,'127.0.0.1',()=>console.log('隔離資料庫：http://127.0.0.1:'+port+'/?page=worklogs'));
