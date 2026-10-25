begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Keep existing one-person assignments, completion and notifications intact.
alter table public.work_assignments
 add column assignment_request_id uuid,
 add column assignment_request_fingerprint text,
 add column construction_plan_id uuid references public.construction_plans(id) on delete restrict,
 add column construction_item_id uuid,
 add column construction_plan_title text,
 add column construction_item_title text,
 add constraint work_assignment_plan_item_fk foreign key (construction_plan_id,construction_item_id)
   references public.construction_plan_items(construction_plan_id,id) on delete restrict,
 add constraint work_assignment_plan_item_check check (construction_item_id is null or construction_plan_id is not null);
create unique index work_assignments_request_user_uidx on public.work_assignments(created_by_user_id,assignment_request_id,assignee_user_id) where assignment_request_id is not null;
create index work_assignments_plan_idx on public.work_assignments(construction_plan_id,construction_item_id) where construction_plan_id is not null;

create function public.create_work_assignments_v1(p_actor_user_id uuid,p_actor text,p_request_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 v_users uuid[]; v_user uuid; v_project_id uuid; v_plan_id uuid; v_item_id uuid;
 v_plan public.construction_plans; v_item public.construction_plan_items;
 v_project public.projects; v_assignment public.work_assignments;
 v_mode text := coalesce(nullif(p_payload->>'project_mode',''),'existing');
 v_type text := p_payload->>'assignment_type';
 v_fingerprint text; v_existing jsonb; v_first boolean := true;
begin
 if not exists(select 1 from public.app_users where id=p_actor_user_id and role='admin' and is_active) then
   raise exception '只有啟用中的管理員可以建立工作指派。';
 end if;
 perform public.erp_private_prepare_v1(p_actor_user_id);
 if p_request_id is null or jsonb_typeof(p_payload->'assignee_user_ids') is distinct from 'array' then
   raise exception '請選擇指派人員並重新開啟表單。';
 end if;
 if jsonb_array_length(p_payload->'assignee_user_ids') not between 1 and 30 then
   raise exception '每次請選擇 1 至 30 位指派人員。';
 end if;
 select array_agg(value::uuid order by value::uuid) into v_users from jsonb_array_elements_text(p_payload->'assignee_user_ids');
 if (select count(distinct u) from unnest(v_users) u) <> cardinality(v_users) then raise exception '指派人員不可重複。'; end if;
 v_fingerprint := md5((p_payload || jsonb_build_object('assignee_user_ids',to_jsonb(v_users)))::text);
 perform pg_advisory_xact_lock(hashtextextended(p_actor_user_id::text || ':' || p_request_id::text,0));
 select jsonb_agg(to_jsonb(a) order by a.assignee_user_id) into v_existing from public.work_assignments a
 where created_by_user_id=p_actor_user_id and assignment_request_id=p_request_id;
 if v_existing is not null then
   if exists(select 1 from public.work_assignments where created_by_user_id=p_actor_user_id and assignment_request_id=p_request_id and assignment_request_fingerprint is distinct from v_fingerprint) then
     raise exception '此表單已送出，請重新開啟表單建立不同指派。';
   end if;
   perform public.erp_private_assert_v1(v_existing);
   return jsonb_build_object('assignments',v_existing,'project_id',v_existing->0->>'project_id','replayed',true);
 end if;
 if v_mode not in ('existing','manual') or v_type is null or v_type not in ('general','pickup') then raise exception '工作指派資料不正確。'; end if;
 if (select count(*) from public.app_users where id=any(v_users) and is_active) <> cardinality(v_users) then raise exception '請選擇啟用中的指派人員。'; end if;
 v_plan_id := nullif(p_payload->>'construction_plan_id','')::uuid;
 v_item_id := nullif(p_payload->>'construction_item_id','')::uuid;
 v_project_id := nullif(p_payload->>'project_id','')::uuid;
 if v_item_id is not null and v_plan_id is null then raise exception '請先選擇施工規劃。'; end if;
 if v_mode='manual' and (v_project_id is not null or v_plan_id is not null or v_item_id is not null) then raise exception '新工作尚無可關聯的施工規劃。'; end if;
 if v_plan_id is not null then
   select * into v_plan from public.construction_plans where id=v_plan_id for share;
   if not found or v_plan.project_id is distinct from v_project_id or v_plan.deleted_at is not null or v_plan.status not in ('pending','in_progress') then raise exception '施工規劃已變更或不屬於此工作，請重新選擇。'; end if;
   if not public.construction_project_access_v1(p_actor_user_id,v_project_id,false) then raise exception '沒有此工作施工規劃的存取權限。'; end if;
   if v_item_id is not null then
     select * into v_item from public.construction_plan_items where id=v_item_id and construction_plan_id=v_plan_id for share;
     if not found or v_item.deleted_at is not null or v_item.is_completed then raise exception '施工子項目已完成、刪除或不屬於此規劃，請重新選擇。'; end if;
   end if;
 end if;
 perform public.erp_private_assert_v1(p_payload);
 if v_mode='existing' then
   select * into v_project from public.projects where id=v_project_id for share;
   if not found or v_project.deleted_at is not null or v_project.status='completed' then raise exception '請選擇有效且尚未完成的工作內容。'; end if;
 end if;
 foreach v_user in array v_users loop
   if v_mode='manual' and v_first then
     select * into v_assignment from public.create_work_assignment_with_project_v1(
       p_payload->>'project_name',(p_payload->>'customer_id')::uuid,nullif(p_payload->>'department_id','')::uuid,
       p_payload->>'project_type',(p_payload->>'project_date')::date,v_user,v_type,p_payload->>'instructions',
       nullif(p_payload->>'inventory_item_id','')::uuid,nullif(p_payload->>'pickup_quantity','')::numeric,p_actor_user_id,p_actor);
     v_project_id := v_assignment.project_id;
     select * into v_project from public.projects where id=v_project_id;
     -- The established writer maintains the shared project-owner relations.
     perform public.upsert_erp_project_department_v1(
       p_id=>v_project_id,p_row_version=>v_project.row_version,p_name=>v_project.name,p_customer_id=>v_project.customer_id,
       p_project_type=>v_project.project_type,p_status=>v_project.status,p_description=>v_project.description,
       p_estimated_cost=>v_project.estimated_cost,p_note=>v_project.note,p_worker_user_ids=>v_users,p_actor=>p_actor,
       p_project_date=>v_project.project_date,p_construction_category=>v_project.construction_category,
       p_department_id=>v_project.department_id,p_construction_category_provided=>true);
   else
     select * into v_assignment from public.create_work_assignment_v1(v_project_id,v_user,v_type,p_payload->>'instructions',
       nullif(p_payload->>'inventory_item_id','')::uuid,nullif(p_payload->>'pickup_quantity','')::numeric,p_actor_user_id,p_actor);
   end if;
   update public.work_assignments set assignment_request_id=p_request_id,assignment_request_fingerprint=v_fingerprint,
     construction_plan_id=v_plan_id,construction_item_id=v_item_id,construction_plan_title=v_plan.content,construction_item_title=v_item.title
   where id=v_assignment.id;
   insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   values('work_assignment',v_assignment.id,'update',jsonb_build_object('construction_plan_id',null,'construction_item_id',null),
     jsonb_build_object('assignment_request_id',p_request_id,'construction_plan_id',v_plan_id,'construction_item_id',v_item_id,
       'construction_plan_title',v_plan.content,'construction_item_title',v_item.title),'web',p_actor);
   v_first := false;
 end loop;
 select jsonb_agg(to_jsonb(a) order by a.assignee_user_id) into v_existing from public.work_assignments a
 where created_by_user_id=p_actor_user_id and assignment_request_id=p_request_id;
 return jsonb_build_object('assignments',v_existing,'project_id',v_project_id,'replayed',false);
end;
$$;
revoke all on function public.create_work_assignments_v1(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.create_work_assignments_v1(uuid,text,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
