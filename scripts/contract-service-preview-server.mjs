import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
const {server}=await createWorklogTestServer({contractCatalog:true});
const port=Number(process.env.CONTRACT_TEST_PORT||4212);
server.listen(port,'127.0.0.1',()=>console.log(`承攬內容隔離資料庫測試：http://127.0.0.1:${port}/?page=crm（不連線正式服務）`));
