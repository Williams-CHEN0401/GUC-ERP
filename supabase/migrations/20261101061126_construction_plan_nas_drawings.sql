begin;
set local lock_timeout='5s';

-- Drawing files stay on the existing NAS; the existing attachment index owns
-- their metadata and the existing construction plan owns their access scope.
alter table public.site_assets add column construction_plan_id uuid references public.construction_plans(id) on delete restrict;
alter table public.site_assets add column contract_service_type_id uuid references public.contract_service_types(id) on delete restrict;
create index site_assets_construction_plan_idx on public.site_assets(construction_plan_id,uploaded_at,id) where construction_plan_id is not null;
alter table public.site_assets add constraint site_assets_construction_drawing_owner_check check (
 construction_plan_id is null or (project_id is not null and work_log_id is null and site_id is null and asset_type='drawing')
);

create function public.construction_drawings_v1(p_actor_user_id uuid,p_plan_id uuid,p_upload boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare scope jsonb; plan public.construction_plans; project public.projects; can_upload boolean;
begin
 select * into plan from public.construction_plans where id=p_plan_id and deleted_at is null;
 if not found then raise exception '找不到施工規劃或沒有查看權限。';end if;
 -- This is the same visibility source used by the planning UI, including
 -- assigned workers, historical authors and private-project restrictions.
 scope:=public.construction_scope_v1(p_actor_user_id,plan.project_id);
 if not exists(select 1 from jsonb_array_elements(scope->'construction_plans') p where p->>'id'=p_plan_id::text) then
  raise exception '找不到施工規劃或沒有查看權限。';end if;
 select * into project from public.projects where id=plan.project_id and deleted_at is null;
 if not found then raise exception '找不到施工工作內容。';end if;
 can_upload:=public.construction_project_access_v1(p_actor_user_id,plan.project_id,true);
 if p_upload and can_upload is not true then raise exception '只有工作內容負責人或管理員可以上傳工程圖。';end if;
 return jsonb_build_object('construction_plan_id',plan.id,'project_id',project.id,'customer_id',project.customer_id,
  'can_upload',can_upload,
  'customers',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name)) from public.customers c where c.id=project.customer_id),'[]'),
  'projects',jsonb_build_array(jsonb_build_object('id',project.id,'name',project.name,'customer_id',project.customer_id)),
  'contract_service_types',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'code',s.code,'is_active',s.is_active) order by s.sort_order,s.name)
   from public.contract_service_types s where s.is_active and exists(select 1 from public.customer_contract_services l where l.customer_id=project.customer_id and l.service_type_id=s.id and l.is_active)),'[]'),
  'customer_contract_services',coalesce((select jsonb_agg(jsonb_build_object('customer_id',l.customer_id,'service_type_id',l.service_type_id,'is_active',l.is_active))
   from public.customer_contract_services l join public.contract_service_types s on s.id=l.service_type_id where l.customer_id=project.customer_id and l.is_active and s.is_active),'[]'),
  'drawings',coalesce((select jsonb_agg(to_jsonb(a) order by a.uploaded_at desc,a.id) from public.site_assets a
   where a.construction_plan_id=plan.id and a.upload_status='uploaded'),'[]'::jsonb));
end $$;

create function public.construction_drawing_path_part_v1(p_value text) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare normalized text; result text:=''; character_value text; character_index integer; unit_count integer:=0; character_units integer;
begin
 normalized:=btrim(regexp_replace(regexp_replace(regexp_replace(pg_catalog.normalize(coalesce(p_value,''),'NFKC'),'[\\/:*?"<>|\x01-\x1F]','_','g'),'[. ]+$','','g'),'\s+',' ','g'));
 for character_index in 1..char_length(normalized) loop
  character_value:=substr(normalized,character_index,1);
  character_units:=case when ascii(character_value)>65535 then 2 else 1 end;
  exit when unit_count+character_units>100;
  result:=result||character_value;unit_count:=unit_count+character_units;
 end loop;
 return coalesce(nullif(result,''),'未命名');
end
$$;

create function public.construction_drawing_upload_context_v1(p_actor_user_id uuid,p_plan_id uuid,p_service_type_id uuid,p_log_date date default (now() at time zone 'Asia/Taipei')::date)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare context jsonb; customer_name text; project_name text; service_name text;
begin
 context:=public.construction_drawings_v1(p_actor_user_id,p_plan_id,true);
 select s.name into service_name from public.contract_service_types s where s.id=p_service_type_id and s.is_active
  and exists(select 1 from public.customer_contract_services l where l.customer_id=(context->>'customer_id')::uuid and l.service_type_id=s.id and l.is_active);
 if not found or p_log_date is null then raise exception '請選擇此客戶已啟用的承攬內容。';end if;
 customer_name:=context#>>'{customers,0,name}';project_name:=context#>>'{projects,0,name}';
 return (context-'drawings')||jsonb_build_object('contract_service_type_id',p_service_type_id,'upload_root','/施工規劃圖','folder_parts',jsonb_build_array(
  public.construction_drawing_path_part_v1(customer_name),public.construction_drawing_path_part_v1(service_name),public.construction_drawing_path_part_v1(project_name),to_char(p_log_date,'YYYY-MM-DD'),p_plan_id::text));
end $$;

create function public.construction_drawing_file_v1(p_actor_user_id uuid,p_asset_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare asset public.site_assets;
begin
 select * into asset from public.site_assets where id=p_asset_id and construction_plan_id is not null and upload_status='uploaded';
 if not found then raise exception '找不到工程圖或沒有查看權限。';end if;
 perform public.construction_drawings_v1(p_actor_user_id,asset.construction_plan_id,false);
 return to_jsonb(asset)||jsonb_build_object('storage_provider','nas');
end $$;

-- Legacy attachment endpoints must not be able to overwrite, unlink or delete
-- a plan drawing merely by submitting its ID or NAS path.
create function public.guard_construction_drawing_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
declare plan_id uuid; project_id uuid;
begin
 plan_id:=case when TG_OP='DELETE' then old.construction_plan_id else new.construction_plan_id end;
 if TG_OP='UPDATE' and old.construction_plan_id is distinct from new.construction_plan_id then raise exception '不能變更工程圖的施工規劃關聯。';end if;
 if plan_id is null then return case when TG_OP='DELETE' then old else new end;end if;
 if TG_OP='DELETE' or nullif(current_setting('app.construction_drawing_plan_id',true),'')::uuid is distinct from plan_id then
  raise exception '工程圖必須使用施工規劃附件流程。';end if;
 select p.project_id into project_id from public.construction_plans p where p.id=plan_id and p.deleted_at is null;
 if project_id is null or new.project_id is distinct from project_id then raise exception '工程圖與施工工作內容不相符。';end if;
 return new;
end $$;
create trigger guard_construction_drawing before insert or update or delete on public.site_assets
for each row execute function public.guard_construction_drawing_v1();

create function public.preserve_plan_with_drawings_v1() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if ((TG_OP='DELETE') or (old.deleted_at is null and new.deleted_at is not null))
  and exists(select 1 from public.site_assets where construction_plan_id=old.id) then
  raise exception '此施工規劃已有工程圖，請改為取消，保留附件與歷史關聯。';end if;
 return case when TG_OP='DELETE' then old else new end;
end $$;
create trigger preserve_plan_with_drawings before update of deleted_at or delete on public.construction_plans
for each row execute function public.preserve_plan_with_drawings_v1();

create function public.register_construction_drawings_v1(p_actor_user_id uuid,p_plan_id uuid,p_service_type_id uuid,p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare context jsonb; row_data jsonb; prior public.site_assets; saved public.site_assets; result jsonb:='[]';
 v_id uuid; path text; filename text; folder text; original text; resolution text; actor text; bytes bigint; previous_context text; upload_day date; uploaded timestamptz;
begin
 -- Serialize registration with plan reassignment/deletion and other batches.
 perform 1 from public.construction_plans where construction_plans.id=p_plan_id for update;
 context:=public.construction_drawing_upload_context_v1(p_actor_user_id,p_plan_id,p_service_type_id);
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 30 then raise exception '每次請上傳 1 至 30 份工程圖。';end if;
 if (select count(distinct r->>'id') from jsonb_array_elements(p_rows) r)<>jsonb_array_length(p_rows)
  or (select count(distinct r->>'nas_path') from jsonb_array_elements(p_rows) r)<>jsonb_array_length(p_rows) then raise exception '工程圖索引含重複或缺少的檔案。';end if;
 select username into actor from public.app_users where app_users.id=p_actor_user_id and is_active;
 if actor is null then raise exception '請先以有效帳號登入。';end if;
 previous_context:=current_setting('app.construction_drawing_plan_id',true);
 perform set_config('app.construction_drawing_plan_id',p_plan_id::text,true);
 for row_data in select value from jsonb_array_elements(p_rows) loop
  v_id:=nullif(row_data->>'id','')::uuid;path:=row_data->>'nas_path';original:=row_data->>'original_name';
  bytes:=(row_data->>'file_size')::bigint;resolution:=coalesce(row_data->>'conflict_resolution','new');
  upload_day:=nullif(row_data->>'log_date','')::date;uploaded:=nullif(row_data->>'uploaded_at','')::timestamptz;
  -- A signed upload may start before midnight and finish afterwards. Index-only
  -- retries use that upload's timestamp, never the later retry date.
  if upload_day is null or uploaded is null or upload_day not between (uploaded at time zone 'Asia/Taipei')::date-1 and (uploaded at time zone 'Asia/Taipei')::date then raise exception '工程圖日期與上傳紀錄不相符。';end if;
  folder:='/施工規劃圖/'||(context#>>'{folder_parts,0}')||'/'||(context#>>'{folder_parts,1}')||'/'||(context#>>'{folder_parts,2}')||'/'||to_char(upload_day,'YYYY-MM-DD')||'/'||p_plan_id::text||'/';
  filename:=substring(path from length(folder)+1);
  if v_id is null or path is null or left(path,length(folder))<>folder or filename is null or length(filename) not between 1 and 100
   or filename in ('.','..') or filename<>btrim(filename) or filename ~ '[[:cntrl:]\\/:*?"<>|]'
   or original is null or length(original) not between 1 and 160 or original ~ '[[:cntrl:]\\/]'
   or lower(original) !~ '\.(pdf|jpe?g|png|webp|heic|heif|dwg|dxf)$' or lower(filename) !~ '\.(pdf|jpe?g|png|webp|heic|heif|dwg|dxf)$'
   or bytes is null or bytes not between 1 and 20971520 or coalesce(length(row_data->>'mime_type'),0) not between 1 and 160
   or coalesce(row_data->>'sha256','') !~ '^[0-9a-f]{64}$' or nullif(row_data->>'uploaded_at','') is null
   or length(coalesce(row_data->>'description',''))>1000 or resolution not in ('new','rename','overwrite') then
   raise exception '工程圖索引、檔案格式、大小或 NAS 路徑不正確。';end if;
  if exists(select 1 from public.site_assets a where a.id=v_id and (a.construction_plan_id is distinct from p_plan_id or a.nas_path is distinct from path)) then
   raise exception '工程圖編號已用於其他檔案。';end if;
  select * into prior from public.site_assets a where a.nas_path=path for update;
  if found then
   if prior.construction_plan_id is distinct from p_plan_id or prior.project_id::text is distinct from (context->>'project_id') or prior.contract_service_type_id is distinct from p_service_type_id then raise exception '此 NAS 路徑已屬於其他附件。';end if;
   -- A retried registration of the exact same verified upload is idempotent.
   if prior.id=v_id and prior.sha256=row_data->>'sha256' and prior.file_size=bytes then result:=result||jsonb_build_array(to_jsonb(prior));continue;end if;
   if resolution<>'overwrite' then raise exception '已有同名工程圖，請明確選擇覆寫或另存新檔。';end if;
   update public.site_assets a set title=original,original_name=original,description=nullif(row_data->>'description',''),mime_type=row_data->>'mime_type',
    file_size=bytes,sha256=row_data->>'sha256',uploaded_by=actor,uploaded_at=(row_data->>'uploaded_at')::timestamptz,upload_status='uploaded',updated_by=actor,
    updated_at=statement_timestamp(),row_version=a.row_version+1 where a.id=prior.id returning * into saved;
  else
   insert into public.site_assets(id,project_id,construction_plan_id,contract_service_type_id,asset_type,title,description,original_name,mime_type,file_size,nas_path,upload_status,uploaded_by,uploaded_at,sha256,source,updated_by)
   values(v_id,(context->>'project_id')::uuid,p_plan_id,p_service_type_id,'drawing',original,nullif(row_data->>'description',''),original,row_data->>'mime_type',bytes,path,'uploaded',actor,uploaded,row_data->>'sha256','nas_webdav',actor)
   returning * into saved;
  end if;
  result:=result||jsonb_build_array(to_jsonb(saved));
 end loop;
 perform set_config('app.construction_drawing_plan_id',coalesce(previous_context,''),true);
 return result;
end $$;

revoke all on function public.construction_drawings_v1(uuid,uuid,boolean),public.construction_drawing_path_part_v1(text),public.construction_drawing_upload_context_v1(uuid,uuid,uuid,date),public.construction_drawing_file_v1(uuid,uuid),public.guard_construction_drawing_v1(),public.preserve_plan_with_drawings_v1(),public.register_construction_drawings_v1(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.construction_drawings_v1(uuid,uuid,boolean),public.construction_drawing_path_part_v1(text),public.construction_drawing_upload_context_v1(uuid,uuid,uuid,date),public.construction_drawing_file_v1(uuid,uuid),public.guard_construction_drawing_v1(),public.preserve_plan_with_drawings_v1(),public.register_construction_drawings_v1(uuid,uuid,uuid,jsonb) to service_role;
commit;
