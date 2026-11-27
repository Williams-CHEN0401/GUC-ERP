-- 工作管理第二版資料庫驗證：在含土庫國小（監視廣播系統設備改善採購案）資料的隔離資料庫執行。
-- 由 verify-construction-equipment-v2-db.mjs 先套用 migration，再於同一交易執行本檔，最後一律 ROLLBACK。
do $verify$
declare
  admin uuid:=(select id from public.app_users where username='williams' and is_active);
  worker uuid:=(select u.id from public.app_users u where u.is_active and u.role<>'admin' and not public.construction_project_access_v1(u.id,(select project_id from public.construction_plans where content='配管作業' and deleted_at is null limit 1),true) limit 1);
  pipe public.construction_plans; wire public.construction_plans; install public.construction_plans; project public.projects;
  office public.construction_plan_items; parking public.construction_plan_items;
  versions jsonb; result jsonb; codes text[]; saved jsonb; n integer; failed boolean; message text;
  drawing public.site_assets;
begin
  select * into strict pipe from public.construction_plans where content='配管作業' and deleted_at is null;
  select * into strict wire from public.construction_plans where content='監視器配線、廣播配線' and deleted_at is null;
  select * into strict install from public.construction_plans where content='設備安裝' and deleted_at is null;
  select * into strict project from public.projects where id=pipe.project_id;
  select * into strict office from public.construction_plan_items where construction_plan_id=pipe.id and title='總務處大樓配管施工' and deleted_at is null;
  select * into strict parking from public.construction_plan_items where construction_plan_id=pipe.id and title='停車場配管施工' and deleted_at is null;
  if office.equipment_codes is not null then raise exception 'existing items must default to null (all roster equipment)'; end if;

  -- 驗收 4：CAM10～CAM20 共 11 筆批次指派至「總務處大樓配管施工」。
  codes:=array(select format('CAM%s',lpad(i::text,2,'0')) from generate_series(10,20) i);
  result:=public.assign_construction_item_equipment_v1(admin,office.id,jsonb_build_object('row_version',office.row_version,'codes',to_jsonb(codes)));
  if (select cardinality(equipment_codes) from public.construction_plan_items where id=office.id)<>11 then raise exception 'assignment count'; end if;
  select * into office from public.construction_plan_items where id=office.id;
  -- 舊版本、清冊外編號、無權限都要拒絕。
  failed:=false; begin perform public.assign_construction_item_equipment_v1(admin,office.id,jsonb_build_object('row_version',office.row_version-1,'codes','[]'::jsonb)); exception when others then failed:=true; end;
  if not failed then raise exception 'stale assignment accepted'; end if;
  failed:=false; begin perform public.assign_construction_item_equipment_v1(admin,office.id,jsonb_build_object('row_version',office.row_version,'codes','["NOPE99"]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%NOPE99%' then raise exception 'unknown code accepted: %',message; end if;
  if worker is not null then
    failed:=false; begin perform public.assign_construction_item_equipment_v1(worker,office.id,jsonb_build_object('row_version',office.row_version,'codes','[]'::jsonb)); exception when others then failed:=true; end;
    if not failed then raise exception 'unauthorized assignment accepted'; end if;
  end if;

  -- 驗收 6：日誌只能填報已指派至該子項目的設備；未指派（null）的子項目維持全部可填。
  failed:=false;
  begin
    saved:=public.save_construction_work_log_v1(admin,pipe.id,jsonb_build_object('request_id',gen_random_uuid(),'construction_plan_id',pipe.id,
      'construction_item_ids',jsonb_build_array(office.id),'construction_item_id',office.id,
      'equipment_progress',jsonb_build_array(jsonb_build_object('code','CAM30','item',office.id,'status','working')),
      'project_id',project.id,'project_name',project.name,'customer_id',project.customer_id,'department_id',project.department_id,
      'worker_user_ids',jsonb_build_array(admin),'log_date',(now() at time zone 'Asia/Taipei')::date,'work_type','工程施工','status','in_progress',
      'time_period','','summary','v2 驗證','completed_content','v2 驗證','pending_content','','maintenance_events','[]'::jsonb));
  exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%未指派%' then raise exception 'unassigned equipment progress accepted: %',message; end if;
  saved:=public.save_construction_work_log_v1(admin,pipe.id,jsonb_build_object('request_id',gen_random_uuid(),'construction_plan_id',pipe.id,
    'construction_item_ids',jsonb_build_array(office.id,parking.id),'construction_item_id',office.id,
    'equipment_progress',jsonb_build_array(jsonb_build_object('code','CAM10','item',office.id,'status','done'),
      jsonb_build_object('code','CAM30','item',parking.id,'status','working')),
    'project_id',project.id,'project_name',project.name,'customer_id',project.customer_id,'department_id',project.department_id,
    'worker_user_ids',jsonb_build_array(admin),'log_date',(now() at time zone 'Asia/Taipei')::date,'work_type','工程施工','status','in_progress',
    'time_period','','summary','v2 驗證','completed_content','v2 驗證','pending_content','','maintenance_events','[]'::jsonb));
  if jsonb_array_length(saved#>'{work_log,equipment_progress}')<>2 then raise exception 'progress not saved'; end if;
  -- 驗收 5：同一設備（CAM10）在配管、配線、安裝三個主項目仍只有一個編號，各自獨立記錄進度。
  if (select count(*) from public.construction_plans p cross join lateral jsonb_array_elements(p.drawing_points) pt where p.project_id=project.id and p.deleted_at is null and pt->>'code'='CAM10')<>3 then raise exception 'CAM10 should appear once per plan'; end if;
  -- 已有紀錄的設備不能從子項目移除。
  select * into office from public.construction_plan_items where id=office.id;
  failed:=false; begin perform public.assign_construction_item_equipment_v1(admin,office.id,jsonb_build_object('row_version',office.row_version,'codes','["CAM11"]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%CAM10%' then raise exception 'recorded equipment removed: %',message; end if;

  -- 「適用全部」改為指定設備時，自動保留已有紀錄的設備（停車場指定 CAM12 時保留 CAM30）。
  select * into parking from public.construction_plan_items where id=parking.id;
  result:=public.assign_construction_item_equipment_v1(admin,parking.id,jsonb_build_object('row_version',parking.row_version,'codes','["CAM12"]'::jsonb));
  if not (result->'equipment_codes' ? 'CAM30' and result->'equipment_codes' ? 'CAM12') then raise exception 'recorded equipment not retained: %',result->'equipment_codes'; end if;

  -- 設備欄位擴充（類型、型號、建築物、備註）並依編號同步其他規劃，位置各自保留。
  select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=project.id and deleted_at is null;
  select * into pipe from public.construction_plans where id=pipe.id;
  result:=public.save_construction_roster_v1(admin,pipe.id,jsonb_build_object('versions',versions,'points',
    (select jsonb_agg(case when p->>'code'='CAM11' then p||'{"name":"總務處走廊","type":"監視攝影機","model":"IPC-2MP","building":"總務處大樓","note":"吸頂"}'::jsonb else p end order by o)
     from jsonb_array_elements(pipe.drawing_points) with ordinality t(p,o))));
  if (select pt->>'model' from public.construction_plans p cross join lateral jsonb_array_elements(p.drawing_points) pt where p.id=install.id and pt->>'code'='CAM11')<>'IPC-2MP' then raise exception 'attributes not synced'; end if;
  failed:=false;
  begin
    select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=project.id and deleted_at is null;
    select * into pipe from public.construction_plans where id=pipe.id;
    perform public.save_construction_roster_v1(admin,pipe.id,jsonb_build_object('versions',versions,'points',pipe.drawing_points||'[{"code":"BAD1","location":"","color":"red"}]'::jsonb));
  exception when others then failed:=true; end;
  if not failed then raise exception 'unknown point key accepted'; end if;
  -- 舊版用戶端未送新欄位時保留原值。
  select * into pipe from public.construction_plans where id=pipe.id;
  perform set_config('app.plan_drawing_points',jsonb_build_object('id',pipe.id,'points',(select jsonb_agg(jsonb_build_object('code',p->>'code','location',p->>'location') order by o) from jsonb_array_elements(pipe.drawing_points) with ordinality t(p,o)))::text,true);
  update public.construction_plans set row_version=row_version+1 where id=pipe.id;
  perform set_config('app.plan_drawing_points','',true);
  if (select pt->>'building' from public.construction_plans p cross join lateral jsonb_array_elements(p.drawing_points) pt where p.id=pipe.id and pt->>'code'='CAM11')<>'總務處大樓' then raise exception 'legacy client dropped attributes'; end if;

  -- 驗收 2、3：系統自動編號一次建立 79 筆不重複設備（ZZ01～ZZ79），加入兩筆規劃並指派子項目。
  select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=project.id and deleted_at is null;
  select * into parking from public.construction_plan_items where id=parking.id;
  result:=public.batch_construction_roster_v1(admin,project.id,jsonb_build_object('versions',versions,'plans',jsonb_build_array(pipe.id,wire.id),
    'assign_item_id',parking.id,'points',(select jsonb_agg(jsonb_build_object('code',format('ZZ%s',lpad(i::text,2,'0')),'name','監視攝影機','type','監視攝影機','location','') order by i) from generate_series(1,79) i)));
  if (result->>'point_count')::int<>79 or (result->>'plan_count')::int<>2 then raise exception 'batch result %',result; end if;
  if (select count(*) from public.construction_plans p cross join lateral jsonb_array_elements(p.drawing_points) pt where p.id in (pipe.id,wire.id) and pt->>'code' like 'ZZ%')<>158 then raise exception 'batch rows missing'; end if;
  -- 停車場已指定 CAM12、CAM30，批次再加上 79 筆新設備。
  if (select cardinality(equipment_codes) from public.construction_plan_items where id=parking.id)<>81
    or not (select 'CAM30'=any(equipment_codes) from public.construction_plan_items where id=parking.id) then raise exception 'batch assignment missing'; end if;
  select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=project.id and deleted_at is null;
  failed:=false; begin perform public.batch_construction_roster_v1(admin,project.id,jsonb_build_object('versions',versions,'plans',jsonb_build_array(pipe.id),'points','[{"code":"zz05","location":""}]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%ZZ05%' then raise exception 'duplicate batch accepted: %',message; end if;

  -- 清冊刪除設備時同步移除子項目指派。
  select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=project.id and deleted_at is null;
  select * into pipe from public.construction_plans where id=pipe.id;
  perform public.save_construction_roster_v1(admin,pipe.id,jsonb_build_object('versions',versions,'points',(select jsonb_agg(p order by o) from jsonb_array_elements(pipe.drawing_points) with ordinality t(p,o) where p->>'code'<>'ZZ79')));
  if (select 'ZZ79'=any(equipment_codes) from public.construction_plan_items where id=parking.id) then raise exception 'removed equipment still assigned'; end if;

  -- 工程圖名稱、分類修改與封存。
  select * into drawing from public.site_assets where construction_plan_id in (pipe.id,wire.id,install.id) and upload_status='uploaded' order by uploaded_at limit 1;
  if drawing.id is not null then
    result:=public.manage_construction_drawing_v1(admin,drawing.id,jsonb_build_object('action','update','row_version',drawing.row_version,'title','總務處 1F','description','v2',
      'category',jsonb_build_object('building','總務處大樓','floor','1F','area','')));
    if result->'drawing_category'<>'{"building":"總務處大樓","floor":"1F"}'::jsonb or result->>'title'<>'總務處 1F' then raise exception 'drawing update %',result; end if;
    perform public.save_construction_drawing_marker_v1(admin,drawing.id,drawing.sha256,'CAM12',null,'{"x":0.5,"y":0.5}'::jsonb);
    select * into drawing from public.site_assets where id=drawing.id;
    failed:=false; begin perform public.manage_construction_drawing_v1(admin,drawing.id,jsonb_build_object('action','archive','row_version',drawing.row_version)); exception when others then failed:=true; message:=sqlerrm; end;
    if not failed or message not like '%點位%' then raise exception 'archive without confirmation: %',message; end if;
    if worker is not null then
      failed:=false; begin perform public.manage_construction_drawing_v1(worker,drawing.id,jsonb_build_object('action','archive','row_version',drawing.row_version,'confirm_markers',true)); exception when others then failed:=true; end;
      if not failed then raise exception 'unauthorized archive accepted'; end if;
    end if;
    result:=public.manage_construction_drawing_v1(admin,drawing.id,jsonb_build_object('action','archive','row_version',drawing.row_version,'confirm_markers',true));
    if result->>'upload_status'<>'archived' or result->'drawing_markers'='{}'::jsonb then raise exception 'archive should keep marker history'; end if;
    if exists(select from jsonb_array_elements(public.construction_drawings_v1(admin,drawing.construction_plan_id)->'drawings') d where d->>'id'=drawing.id::text) then raise exception 'archived drawing still listed'; end if;
  else raise notice 'no construction drawing available; drawing checks skipped';
  end if;

  -- 查詢投影帶出子項目指派欄位。
  if not exists(select from jsonb_array_elements(public.construction_scope_v1(admin,project.id)->'construction_plans') p cross join lateral jsonb_array_elements(p->'items') i
    where i->>'id'=office.id::text and i->'equipment_codes' ? 'CAM20') then raise exception 'scope missing equipment_codes'; end if;
  raise notice 'construction equipment v2 checks passed (worker=%)',worker is not null;
end $verify$;
