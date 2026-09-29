-- Production migration version: 20260929150841 (local draft: 20260929145444).
begin;
set local lock_timeout = '5s';

-- A repair's source event remains a provenance link. Each record owns its
-- customer, department, dates and item fields; editing one never edits the other.
-- Replace only existing bodies, preserving function OIDs, signatures and ACLs.
do $$
declare v_definition text; v_old text;
begin
  v_definition:=replace(pg_get_functiondef('public.upsert_customer_project_work_log_v3(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,text)'::regprocedure),chr(13),'');
  v_old:=$old$        if exists(select 1 from public.repair_items r join public.maintenance_events e on e.id=r.source_maintenance_event_id where e.work_log_id=p_id) then
          raise exception '此日誌已登錄維修品，請先處理維修品的客戶／科室關聯，不能直接變更客戶或科室。';
        end if;
$old$;
  v_old:=replace(v_old,chr(13),'');
  if position(v_old in v_definition)=0 then raise exception 'Unexpected work-log repair ownership baseline'; end if;
  execute replace(v_definition,v_old,'');

  v_definition:=replace(pg_get_functiondef('public.upsert_work_log_with_department_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text,uuid,uuid)'::regprocedure),chr(13),'');
  v_old:=$old$ if p_id is not null and exists(select 1 from public.repair_items r join public.maintenance_events e on e.id=r.source_maintenance_event_id
  where e.work_log_id=p_id and (r.customer_id is distinct from p_customer_id or r.department_id is distinct from p_department_id)) then
  raise exception '此日誌已登錄維修品，不能直接變更維修品的客戶或科室。';
 end if;
$old$;
  v_old:=replace(v_old,chr(13),'');
  if position(v_old in v_definition)=0 then raise exception 'Unexpected work-log repair department baseline'; end if;
  execute replace(v_definition,v_old,'');

  v_definition:=replace(pg_get_functiondef('public.upsert_customer_project_work_log_with_maintenance_v1(uuid,integer,uuid,uuid,text,date,text,text,text,text,uuid[],uuid,jsonb,text)'::regprocedure),chr(13),'');
  v_old:=$old$      if exists(select 1 from public.repair_items where source_maintenance_event_id=v_before.id)
        and (
          v_inventory_item_id is distinct from v_before.inventory_item_id
          or v_category_id is distinct from v_before.inventory_category_id
        ) then
        raise exception '此明細已登錄維修品，品項請至維修品管理修改。';
      end if;
$old$;
  v_old:=replace(v_old,chr(13),'');
  if position(v_old in v_definition)=0 then raise exception 'Unexpected maintenance repair item baseline'; end if;
  v_definition:=replace(v_definition,v_old,'');
  v_old:=$old$  -- Keep linked repairs on the parent work-log date, including a date-only edit.
  -- Manual repairs have no source event and are deliberately excluded.
  for v_before_repair in
    select r.* from public.repair_items r
    join public.maintenance_events e on e.id=r.source_maintenance_event_id
    where e.work_log_id=v_work_log_id and r.received_on is distinct from p_log_date
    order by r.id for update of r
  loop
    update public.repair_items set received_on=p_log_date,updated_by=p_actor
      where id=v_before_repair.id returning * into v_repair;
    insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
      values('repair_items',v_repair.id,'UPDATE_REPAIR_ITEM',to_jsonb(v_before_repair),to_jsonb(v_repair),'work_log',p_actor);
  end loop;
$old$;
  v_old:=replace(v_old,chr(13),'');
  if position(v_old in v_definition)=0 then raise exception 'Unexpected maintenance repair date baseline'; end if;
  execute replace(v_definition,v_old,'');
end $$;

-- No data backfill, schema, grants, RLS or source-link changes. The existing
-- equipment ownership, attachment, authorization, audit, replay and version
-- checks are deliberately unchanged.
commit;
