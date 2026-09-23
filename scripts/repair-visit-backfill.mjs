// Explicit, reviewed manifest only. Generates SQL; never connects to production.
// Keep real snapshots outside Git. All writes share one guarded transaction.
const uuid=value=>{if(!/^[0-9a-f-]{36}$/i.test(value))throw Error('Invalid UUID');return `'${value}'::uuid`;};
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const rows=(table,where,order='id')=>`(select coalesce(jsonb_agg(to_jsonb(t) order by ${order}),'[]'::jsonb) from public.${table} t where ${where})`;
export function snapshotExpression(projectIds){
 const projects=projectIds.map(uuid).join(','),logs=`select id from public.site_work_logs where project_id in (${projects})`;
 const fields={
  projects:rows('projects',`id in (${projects})`),
  sites:rows('sites',`project_id in (${projects})`),
  logs:rows('site_work_logs',`project_id in (${projects})`),
  log_workers:rows('site_work_log_workers',`work_log_id in (${logs})`,'work_log_id,user_id'),
  grants:rows('project_workers',`project_id in (${projects})`,'project_id,user_id'),
  pickups:rows('pickup_records',`project_id in (${projects}) or work_log_id in (${logs})`),
  events:rows('maintenance_events',`work_log_id in (${logs})`),
  assets:rows('site_assets',`project_id in (${projects}) or work_log_id in (${logs})`),
  quotations:rows('quotations',`project_id in (${projects})`),
  assignments:rows('work_assignments',`project_id in (${projects})`),
  costs:rows('project_costs',`project_id in (${projects})`),
  devices:rows('site_devices',`site_id in (select id from public.sites where project_id in (${projects}))`)
 };
 return `jsonb_build_object(${Object.entries(fields).map(([k,v])=>literal(k)+','+v).join(',\n')})`;
}
export const snapshotQuery=ids=>'select '+snapshotExpression(ids)+' snapshot';
export function buildBackfill({snapshot,targetIds,actorId,actor,operation}){
 if(!snapshot?.projects?.length||!targetIds?.length)throw Error('Empty manifest');
 if(!/^[a-z0-9-]+$/.test(operation))throw Error('Invalid operation');
 const sourceIds=snapshot.projects.map(p=>p.id),expression=snapshotExpression(sourceIds);
 const expected=snapshot.logs.filter(l=>!l.deleted_at).sort((a,b)=>String(a.log_date).localeCompare(String(b.log_date))||String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id));
 const seen=new Set(),later=[];
 for(const log of expected){if(log.work_type!=='維修紀錄')throw Error('Mixed work types require manual review');if(seen.has(log.project_id))later.push(log.id);seen.add(log.project_id);}
 if(JSON.stringify([...later].sort())!==JSON.stringify([...targetIds].sort()))throw Error('Targets must be exactly the later repair visits');
 for(const key of ['quotations','assignments','costs','devices'])if(snapshot[key].length)throw Error('Dependency requires review: '+key);
 // Unlinked project attachments stay with the original work. A visit-specific
 // attachment needs a separately reviewed storage/index relocation and blocks.
 if(snapshot.assets.some(a=>targetIds.includes(a.work_log_id)))throw Error('Dependency requires review: visit assets');
 for(const p of snapshot.projects)if(p.deleted_at||p.project_type!=='repair')throw Error('Invalid source project');
 for(const p of snapshot.pickups)if(p.work_log_id&&targetIds.includes(p.work_log_id)&&p.project_id!==snapshot.logs.find(l=>l.id===p.work_log_id).project_id)throw Error('Pickup link mismatch');
 return `begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $repair_backfill$
declare
 v_expected jsonb:=${literal(JSON.stringify(snapshot))}::jsonb;
 v_source_ids uuid[]:=array[${sourceIds.map(uuid)}];
 v_targets uuid[]:=array[${targetIds.map(uuid)}];
 v_operation text:=${literal(operation)};
 v_actor text:=${literal(actor)};
 v_actor_id uuid:=${uuid(actorId)};
 v_before jsonb; v_now jsonb; v_quote_hash text; v_inventory_hash text;
 v_log public.site_work_logs; v_source public.projects; v_new public.projects; v_site public.sites;
 v_name text; v_before_pickups jsonb; v_after_pickups jsonb; v_source_grants jsonb; v_new_grants jsonb;
 v_after_log jsonb; v_count integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended(v_operation,0));
 if exists(select 1 from public.audit_logs where source=v_operation and entity_type='repair_visit_reorganization') then
  if (select count(*) from public.audit_logs where source=v_operation and entity_type='repair_visit_reorganization')<>cardinality(v_targets) then raise exception 'Incomplete prior operation'; end if;
  raise notice 'Operation already completed; no writes'; return;
 end if;
 if not exists(select 1 from public.app_users where id=v_actor_id and username=v_actor and role='admin' and is_active) then raise exception 'Active administrator required'; end if;
 perform 1 from public.customers where id in (select customer_id from public.projects where id=any(v_source_ids)) order by id for update;
 perform 1 from public.projects where id=any(v_source_ids) order by id for update;
 perform 1 from public.site_work_logs where project_id=any(v_source_ids) order by id for update;
 perform 1 from public.pickup_records where project_id=any(v_source_ids) or work_log_id in (select id from public.site_work_logs where project_id=any(v_source_ids)) order by id for update;
 perform 1 from public.project_workers where project_id=any(v_source_ids) order by project_id,user_id for share;
 perform 1 from public.maintenance_events where work_log_id in (select id from public.site_work_logs where project_id=any(v_source_ids)) order by id for share;
 select ${expression} into v_before;
 if v_before is distinct from v_expected then raise exception 'Snapshot changed; stop and review a fresh backup'; end if;
 select md5(coalesce(jsonb_agg(to_jsonb(q) order by id),'[]')::text) into v_quote_hash from public.quotations q;
 select md5(coalesce(jsonb_agg(to_jsonb(i) order by id),'[]')::text) into v_inventory_hash from public.inventory_items i;
 for v_log in select * from public.site_work_logs where id=any(v_targets) order by project_id,log_date,created_at,id loop
  select * into strict v_source from public.projects where id=v_log.project_id;
  v_name:=public.repair_visit_name_v1(v_source.customer_id,v_source.name,v_log.log_date);
  select * into v_new from public.create_project_auto_number_v1(v_name,v_source.customer_id,'repair',v_log.status,v_source.assigned_to,'由既有維修日誌獨立整理',null,null,v_actor);
  update public.projects set department_id=v_source.department_id,updated_by=v_actor where id=v_new.id and department_id is distinct from v_source.department_id;
  insert into public.project_workers(project_id,user_id,is_assignee,can_view,can_create_work_log,can_update_work_log,can_delete_work_log,granted_by,granted_at)
   select v_new.id,user_id,is_assignee,can_view,can_create_work_log,can_update_work_log,can_delete_work_log,v_actor_id,now() from public.project_workers where project_id=v_source.id;
  select * into v_site from public.ensure_project_site_v1(v_new.id,v_actor);
  select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') into v_before_pickups from public.pickup_records p where work_log_id=v_log.id;
  update public.site_work_logs set site_id=v_site.id,project_id=v_new.id,title=v_name,updated_by=v_actor where id=v_log.id;
  update public.pickup_records set project_id=v_new.id,updated_by=v_actor where work_log_id=v_log.id;
  select to_jsonb(l) into v_after_log from public.site_work_logs l where id=v_log.id;
  if v_after_log-array['site_id','project_id','title','updated_by','updated_at','row_version'] is distinct from to_jsonb(v_log)-array['site_id','project_id','title','updated_by','updated_at','row_version'] then raise exception 'Unrelated log fields changed'; end if;
  if v_after_log->>'project_id'<>v_new.id::text or v_after_log->>'site_id'<>v_site.id::text or v_after_log->>'title'<>v_name then raise exception 'Log association verification failed'; end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') into v_after_pickups from public.pickup_records p where work_log_id=v_log.id;
  if (select coalesce(jsonb_agg(x-array['project_id','updated_by','updated_at','row_version'] order by x->>'id'),'[]') from jsonb_array_elements(v_before_pickups) x) is distinct from
     (select coalesce(jsonb_agg(x-array['project_id','updated_by','updated_at','row_version'] order by x->>'id'),'[]') from jsonb_array_elements(v_after_pickups) x) then raise exception 'Pickup content changed'; end if;
  if exists(select 1 from public.pickup_records where work_log_id=v_log.id and project_id is distinct from v_new.id) then raise exception 'Pickup association verification failed'; end if;
  select coalesce(jsonb_agg(to_jsonb(g)-array['project_id','created_at','granted_by','granted_at'] order by user_id),'[]') into v_source_grants from public.project_workers g where project_id=v_source.id;
  select coalesce(jsonb_agg(to_jsonb(g)-array['project_id','created_at','granted_by','granted_at'] order by user_id),'[]') into v_new_grants from public.project_workers g where project_id=v_new.id;
  if v_source_grants is distinct from v_new_grants then raise exception 'Inherited access mismatch'; end if;
  insert into public.audit_logs(entity_type,entity_id,action,before_data,after_data,source,actor)
   values('repair_visit_reorganization',v_log.id,'update',jsonb_build_object('work_log',to_jsonb(v_log),'pickups',v_before_pickups),
    jsonb_build_object('work_log',v_after_log,'pickups',v_after_pickups,'new_project_id',v_new.id,'new_site_id',v_site.id,'inherited_access',v_new_grants),v_operation,v_actor);
  v_count:=v_count+1;
 end loop;
 if v_count<>cardinality(v_targets) then raise exception 'Target count mismatch'; end if;
 -- Re-read every source and preserved child. Only the specified logs and linked
 -- pickups may differ; source projects, workers, history and quotation rows stay.
 select ${expression} into v_now;
 if v_now-array['logs','pickups','events','log_workers'] is distinct from v_before-array['logs','pickups','events','log_workers'] then raise exception 'Source data changed'; end if;
 if v_now->'logs' is distinct from (select coalesce(jsonb_agg(x order by x->>'id'),'[]') from jsonb_array_elements(v_before->'logs') x where not (x->>'id')::uuid=any(v_targets)) then raise exception 'Remaining logs changed'; end if;
 if v_now->'pickups' is distinct from (select coalesce(jsonb_agg(x order by x->>'id'),'[]') from jsonb_array_elements(v_before->'pickups') x where not coalesce((x->>'work_log_id')::uuid=any(v_targets),false)) then raise exception 'Remaining pickups changed'; end if;
 if (select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.maintenance_events e where work_log_id in (select (x->>'id')::uuid from jsonb_array_elements(v_before->'logs') x)) is distinct from v_before->'events' then raise exception 'Maintenance events changed'; end if;
 if (select coalesce(jsonb_agg(to_jsonb(w) order by work_log_id,user_id),'[]') from public.site_work_log_workers w where work_log_id in (select (x->>'id')::uuid from jsonb_array_elements(v_before->'logs') x)) is distinct from v_before->'log_workers' then raise exception 'Log workers changed'; end if;
 if (select md5(coalesce(jsonb_agg(to_jsonb(q) order by id),'[]')::text) from public.quotations q) is distinct from v_quote_hash then raise exception 'Quotations changed'; end if;
 if (select md5(coalesce(jsonb_agg(to_jsonb(i) order by id),'[]')::text) from public.inventory_items i) is distinct from v_inventory_hash then raise exception 'Inventory changed'; end if;
end $repair_backfill$;
commit;
select entity_id as work_log_id,before_data->'work_log'->>'project_id' old_project_id,after_data->>'new_project_id' new_project_id,after_data->'work_log'->>'title' name,jsonb_array_length(after_data->'pickups') pickups,jsonb_array_length(after_data->'inherited_access') access_rows
from public.audit_logs where source=${literal(operation)} and entity_type='repair_visit_reorganization' order by entity_id;`;
}
