import {createWorklogTestServer} from './worklog-save-preview-server.mjs';
import {applyEditContext} from './worklog-edit-context-fixture.mjs';
import {applyMaintenanceDepartment,applyIndependentStatus,seedMeetingRooms} from './maintenance-department-fixture.mjs';
const {server,db}=await createWorklogTestServer({formSync:true});
await applyEditContext(db);await applyMaintenanceDepartment(db);await applyIndependentStatus(db);await seedMeetingRooms(db);
const port=Number(process.env.WORKLOG_TEST_PORT||4222);
server.listen(port,'127.0.0.1',()=>console.log('Isolated maintenance departments http://127.0.0.1:'+port+'/?page=worklogs'));
