// Synthetic multi-person requests; existing isolated DB and actual Gateway/RPCs.
import {adminAssignmentFixture} from './admin-assignment-fixture.mjs';
import {callAsService} from './department-cross-system-fixture.mjs';
import {randomUUID} from 'node:crypto';

export async function assignmentGroupingFixture(){
 const f=await adminAssignmentFixture(),{db,users,records}=f;
 const create=(assignee,notes)=>callAsService(db,'create_work_assignment_v1',[f.planProjects.repair,assignee,'general',notes,null,null,users.admin,'隔離管理員']);
 // The persisted production batch ID is the grouping source, not text matching.
 const group=async rows=>{
  const requestId=randomUUID();
  for(const row of rows){await db.query('update work_assignments set assignment_request_id=$1 where id=$2',[requestId,row.id]);Object.assign(row,(await db.query('select * from work_assignments where id=$1',[row.id])).rows[0]);}
  return {requestId,rows};
 };
 const sharedNotes='多人共同指派：電話與讀卡機查修（隔離範例）';
 records.shared=await group([await create(users.A,sharedNotes),await create(users.B,sharedNotes)]);
 records.separate=await group([await create(users.B,sharedNotes)]);
 records.adminShared=await group([await create(users.A,'管理員共同參與的工作（隔離範例）'),await create(users.admin,'管理員共同參與的工作（隔離範例）')]);
 return f;
}
