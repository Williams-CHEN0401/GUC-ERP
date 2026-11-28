-- 工作管理第三版資料庫驗證：設備轉移與工程圖指定顯示設備。
-- 在含土庫國小（監視廣播系統設備改善採購案）資料的隔離資料庫，於同一交易執行後一律 ROLLBACK。
do $verify$
declare
  admin uuid:=(select id from public.app_users where username='williams' and is_active);
  project public.projects; install public.construction_plans; pipe public.construction_plans;
  worker uuid;
  drawing public.site_assets; item_a public.construction_plan_items; item_b public.construction_plan_items; install_item public.construction_plan_items;
  versions jsonb; result jsonb; failed boolean; message text; saved jsonb;
begin
  select * into strict project from public.projects where name like '%監視廣播系統設備改善採購案%' and deleted_at is null;
  select * into strict install from public.construction_plans where project_id=project.id and content='設備安裝' and deleted_at is null;
  select * into strict pipe from public.construction_plans where project_id=project.id and content='配管作業' and deleted_at is null;
  select * into strict drawing from public.site_assets where construction_plan_id=install.id and upload_status='uploaded' and lower(original_name) ~ '\.(jpe?g|png|webp)$' limit 1;
  select * into strict install_item from public.construction_plan_items where construction_plan_id=install.id and deleted_at is null order by sort_order,id limit 1;
  select * into strict item_a from public.construction_plan_items where construction_plan_id=pipe.id and deleted_at is null order by sort_order,id limit 1;
  select * into strict item_b from public.construction_plan_items where construction_plan_id=pipe.id and deleted_at is null and id<>item_a.id order by sort_order,id limit 1;
  worker:=(select u.id from public.app_users u where u.is_active and u.role<>'admin'
    and not exists(select from jsonb_array_elements(public.construction_scope_v1(u.id,project.id)->'construction_plans') v where (v->>'can_manage')::boolean) limit 1);

  -- 準備：設備安裝新增 V3A1、V3A2（無紀錄）、V3C1（將在工程圖定位）、V3C2；配管作業新增 V3B1（將有施工紀錄）。
  select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=project.id and deleted_at is null;
  perform public.batch_construction_roster_v1(admin,project.id,jsonb_build_object('versions',versions,'plans',jsonb_build_array(install.id),
    'points','[{"code":"V3A1","name":"第三版甲","type":"監視攝影機","location":"1F"},{"code":"V3A2","name":"第三版乙","location":"1F"},{"code":"V3C1","location":"2F"},{"code":"V3C2","location":"2F"}]'::jsonb));
  select jsonb_object_agg(id::text,row_version) into versions from public.construction_plans where project_id=project.id and deleted_at is null;
  perform public.batch_construction_roster_v1(admin,project.id,jsonb_build_object('versions',versions,'plans',jsonb_build_array(pipe.id),
    'assign_item_id',item_a.id,'points','[{"code":"V3B1","location":"1F"}]'::jsonb));

  -- 1. 跨主項目轉移：V3A1、V3A2 從「設備安裝」轉到「配管作業」並指派子項目；設備資料保留。
  result:=public.transfer_construction_equipment_v1(admin,project.id,jsonb_build_object('from_plan_id',install.id,'to_plan_id',pipe.id,'to_item_id',item_b.id,'codes','["V3A1","V3A2"]'::jsonb));
  if (result->>'moved')::int<>2 then raise exception 'transfer result %',result; end if;
  if exists(select from public.construction_plans p cross join lateral jsonb_array_elements(p.drawing_points) pt where p.id=install.id and pt->>'code' in ('V3A1','V3A2')) then raise exception 'source still has transferred equipment'; end if;
  if (select pt->>'name' from public.construction_plans p cross join lateral jsonb_array_elements(p.drawing_points) pt where p.id=pipe.id and pt->>'code'='V3A1') is distinct from '第三版甲' then raise exception 'attributes not kept'; end if;
  if not (select equipment_codes @> array['V3A1','V3A2'] from public.construction_plan_items where id=item_b.id) then raise exception 'target item not assigned'; end if;

  -- 2. 同主項目內轉移子項目：V3A1 從 item_b 轉到 item_a。
  perform public.transfer_construction_equipment_v1(admin,project.id,jsonb_build_object('from_plan_id',pipe.id,'to_plan_id',pipe.id,'to_item_id',item_a.id,'codes','["V3A1"]'::jsonb));
  if (select 'V3A1'=any(equipment_codes) from public.construction_plan_items where id=item_b.id) then raise exception 'not removed from previous item'; end if;
  if not (select 'V3A1'=any(equipment_codes) from public.construction_plan_items where id=item_a.id) then raise exception 'not added to target item'; end if;
  failed:=false; begin perform public.transfer_construction_equipment_v1(admin,project.id,jsonb_build_object('from_plan_id',pipe.id,'to_plan_id',pipe.id,'codes','["V3A1"]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%子項目%' then raise exception 'same-plan transfer without item accepted: %',message; end if;

  -- 3. 已有施工紀錄的設備不能轉到其他主項目。
  saved:=public.save_construction_work_log_v1(admin,pipe.id,jsonb_build_object('request_id',gen_random_uuid(),'construction_plan_id',pipe.id,
    'construction_item_ids',jsonb_build_array(item_a.id),'construction_item_id',item_a.id,
    'equipment_progress',jsonb_build_array(jsonb_build_object('code','V3B1','item',item_a.id,'status','working')),
    'project_id',project.id,'project_name',project.name,'customer_id',project.customer_id,'department_id',project.department_id,
    'worker_user_ids',jsonb_build_array(admin),'log_date',(now() at time zone 'Asia/Taipei')::date,'work_type','工程施工','status','in_progress',
    'time_period','','summary','v3 驗證','completed_content','v3 驗證','pending_content','','maintenance_events','[]'::jsonb));
  failed:=false; begin perform public.transfer_construction_equipment_v1(admin,project.id,jsonb_build_object('from_plan_id',pipe.id,'to_plan_id',install.id,'codes','["V3B1"]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%施工紀錄%V3B1%' then raise exception 'recorded equipment transferred: %',message; end if;
  -- 同主項目內，有紀錄的子項目不能移出。
  failed:=false; begin perform public.transfer_construction_equipment_v1(admin,project.id,jsonb_build_object('from_plan_id',pipe.id,'to_plan_id',pipe.id,'to_item_id',item_b.id,'codes','["V3B1"]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%V3B1%' then raise exception 'recorded equipment moved between items: %',message; end if;

  -- 4. 工程圖指定顯示設備；圖上已定位的設備自動保留，清冊外編號、舊版本、無權限皆拒絕。
  perform public.save_construction_drawing_marker_v1(admin,drawing.id,drawing.sha256,'V3C1',null,'{"x":0.4,"y":0.4}'::jsonb);
  select * into drawing from public.site_assets where id=drawing.id;
  result:=public.assign_construction_drawing_equipment_v1(admin,drawing.id,jsonb_build_object('row_version',drawing.row_version,'codes','["V3C2"]'::jsonb));
  if not (result->'drawing_codes' ? 'V3C2' and result->'drawing_codes' ? 'V3C1') then raise exception 'marker equipment not retained: %',result->'drawing_codes'; end if;
  select * into drawing from public.site_assets where id=drawing.id;
  failed:=false; begin perform public.assign_construction_drawing_equipment_v1(admin,drawing.id,jsonb_build_object('row_version',drawing.row_version,'codes','["NOPE77"]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%NOPE77%' then raise exception 'unknown drawing code accepted: %',message; end if;
  failed:=false; begin perform public.assign_construction_drawing_equipment_v1(admin,drawing.id,jsonb_build_object('row_version',drawing.row_version-1,'codes','[]'::jsonb)); exception when others then failed:=true; end;
  if not failed then raise exception 'stale drawing assignment accepted'; end if;
  if worker is not null then
    failed:=false; begin perform public.assign_construction_drawing_equipment_v1(worker,drawing.id,jsonb_build_object('row_version',drawing.row_version,'codes','[]'::jsonb)); exception when others then failed:=true; end;
    if not failed then raise exception 'unauthorized drawing assignment accepted'; end if;
    failed:=false; begin perform public.transfer_construction_equipment_v1(worker,project.id,jsonb_build_object('from_plan_id',install.id,'to_plan_id',pipe.id,'codes','["V3C2"]'::jsonb)); exception when others then failed:=true; end;
    if not failed then raise exception 'unauthorized transfer accepted'; end if;
  end if;
  -- 讀取投影帶出 drawing_codes。
  if not exists(select from jsonb_array_elements(public.construction_drawings_v1(admin,install.id)->'drawings') d where d->>'id'=drawing.id::text and d->'drawing_codes' ? 'V3C2') then raise exception 'drawing_codes not returned'; end if;

  -- 5. 圖上已定位的設備不能轉移；清冊移除設備時同步移除工程圖指定。
  failed:=false; begin perform public.transfer_construction_equipment_v1(admin,project.id,jsonb_build_object('from_plan_id',install.id,'to_plan_id',pipe.id,'codes','["V3C1"]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%定位%V3C1%' then raise exception 'marked equipment transferred: %',message; end if;
  perform public.transfer_construction_equipment_v1(admin,project.id,jsonb_build_object('from_plan_id',install.id,'to_plan_id',pipe.id,'codes','["V3C2"]'::jsonb));
  if (select 'V3C2'=any(drawing_codes) from public.site_assets where id=drawing.id) then raise exception 'drawing assignment not pruned'; end if;
  -- 目標子項目須屬於目標主項目。
  failed:=false; begin perform public.transfer_construction_equipment_v1(admin,project.id,jsonb_build_object('from_plan_id',pipe.id,'to_plan_id',install.id,'to_item_id',item_a.id,'codes','["V3A2"]'::jsonb)); exception when others then failed:=true; message:=sqlerrm; end;
  if not failed or message not like '%目標子項目%' then raise exception 'foreign target item accepted: %',message; end if;

  -- 6. 恢復顯示全部（null）。
  select * into drawing from public.site_assets where id=drawing.id;
  result:=public.assign_construction_drawing_equipment_v1(admin,drawing.id,jsonb_build_object('row_version',drawing.row_version,'codes',null));
  if result->'drawing_codes'<>'null'::jsonb then raise exception 'reset failed %',result->'drawing_codes'; end if;
  raise notice 'construction roster v3 checks passed (worker=%)',worker is not null;
end $verify$;
