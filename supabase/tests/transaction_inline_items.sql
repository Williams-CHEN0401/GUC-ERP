-- Run only against the isolated, restored GUC diagnostic database. Always rolls back.
begin;
set local statement_timeout='30s';
do $$
declare actor uuid:='5926554a-b8cc-4756-8d66-0a9a0877f94e';project uuid:='ae4789ca-469e-495f-901e-a0f0e4bef90b';
 category uuid;supplier uuid;request uuid:=gen_random_uuid();args jsonb;res jsonb;item uuid;denied uuid;failed boolean;stats jsonb;expected record;line record;
begin
 if current_database()<>'guc_construction_relink_20261113' then raise exception 'isolated fixture database required';end if;
 select id into category from public.product_categories where name='監控設備' and is_active limit 1;
 select id into supplier from public.suppliers limit 1;
 args:=jsonb_build_object('p_request_id',request,'p_rows',jsonb_build_array(jsonb_build_object('pickup_date',current_date,'project_id',project,'quantity',2,'quantity_unit','package','new_item',jsonb_build_object('category_id',category,'item_name','SQL原子新增驗收','brand','TEST','unit','台'))));
 res:=public.create_transaction_inline_items_v1('pickup',actor,args);
 select inventory_item_id into item from public.pickup_records where request_id=request;
 if res<>'1'::jsonb or public.current_inventory_quantity(item)<>-2 then raise exception 'new pickup must remain -2';end if;
 perform public.create_transaction_inline_items_v1('pickup',actor,args);
 if (select count(*) from public.pickup_records where request_id=request)<>1 then raise exception 'retry duplicated pickup';end if;
 failed:=false;begin perform public.create_transaction_inline_items_v1('pickup',actor,jsonb_set(args,'{p_rows,0,quantity}','3'));exception when others then failed:=true;end;
 if not failed then raise exception 'changed retry accepted';end if;
 select id into denied from public.app_users where is_active and not public.has_app_permission_v1(id,'inventory','CREATE') limit 1;
 if denied is null then raise exception 'denied fixture missing';end if;
 failed:=false;begin perform public.create_transaction_inline_items_v1('pickup',denied,args);exception when others then failed:=true;end;
 if not failed then raise exception 'unauthorized master creation accepted';end if;
 -- Failure occurs after master creation, so the entire write must roll back.
 args:=jsonb_set(jsonb_set(args,'{p_request_id}',to_jsonb(gen_random_uuid())),'{p_rows,0,new_item,item_name}','"SQL失敗不留品項"');
 args:=jsonb_set(args,'{p_rows,0,project_id}',to_jsonb(gen_random_uuid()));
 failed:=false;begin perform public.create_transaction_inline_items_v1('pickup',actor,args);exception when others then failed:=true;end;
 if not failed or exists(select 1 from public.inventory_items where item_name='SQL失敗不留品項') then raise exception 'failed document left an orphan item';end if;
 -- Seed two attendance dates, plus duplicate logs on the same date; rollback below.
 update public.site_work_logs set subcontractor_count=0 where project_id=project;
 for line in select id,log_date from public.site_work_logs where project_id=project and work_type='工程施工' order by log_date,id limit 3 loop
  update public.site_work_logs set subcontractor_count=2 where id=line.id;
 end loop;
 select count(*) days,coalesce(sum(headcount),0) people into expected from(select log_date,max(subcontractor_count) headcount from public.site_work_logs where project_id=project and deleted_at is null and work_type='工程施工' and subcontractor_count>0 group by log_date) d;
 select value into stats from jsonb_array_elements(public.work_content_report_v1(actor,project,null,null,null,false)->'report'->'workerStats') where value->>'id'='subcontractor';
 if (stats->>'constructionDays')::int<>expected.days or (stats->>'personCount')::int<>expected.people then raise exception 'person counts and dates disagree: % expected %',stats,expected;end if;
 if has_function_privilege('anon','public.create_transaction_inline_items_v1(text,uuid,jsonb)','execute') or has_function_privilege('authenticated','public.create_transaction_inline_items_v1(text,uuid,jsonb)','execute') then raise exception 'untrusted role may call internal writer';end if;
 raise notice 'inline-item atomicity, retry, denied access, negative stock and personnel checks passed';
end $$;
rollback;
