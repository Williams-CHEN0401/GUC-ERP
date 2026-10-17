begin;
set local lock_timeout='5s';

-- Keep the existing customer identity and every historical foreign key intact.
alter table public.customers add column if not exists deleted_at timestamptz;
alter table public.customers add column if not exists deleted_by uuid references public.app_users(id);
create index if not exists customers_active_code_idx on public.customers(customer_code) where deleted_at is null;

create or replace function public.delete_customer_record(p_id uuid,p_row_version integer,p_actor text)
returns integer language plpgsql security definer set search_path='' as $$
declare v_row public.customers; v_user uuid;
begin
 select id into v_user from public.app_users where username=p_actor and is_active;
 if v_user is null or not public.has_app_permission_v1(v_user,'customers','DELETE') then raise exception '您的帳號沒有刪除客戶的權限。'; end if;
 select * into v_row from public.customers where id=p_id for update;
 if not found or v_row.deleted_at is not null then raise exception '找不到有效客戶，或客戶已封存。'; end if;
 if v_row.row_version<>p_row_version then raise exception '客戶資料已被其他使用者更新，請重新載入後再刪除。'; end if;
 perform set_config('app.actor',p_actor,true);
 update public.customers set deleted_at=clock_timestamp(),deleted_by=v_user where id=p_id;
 return 1;
end;
$$;
revoke all on function public.delete_customer_record(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.delete_customer_record(uuid,integer,text) to service_role;

create or replace function public.require_active_customer_link_v1()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.customer_id is not null and (tg_op='INSERT' or new.customer_id is distinct from old.customer_id) then
  perform 1 from public.customers where id=new.customer_id and deleted_at is null for share;
  if not found then
   -- PostgreSQL runs BEFORE INSERT even for ON CONFLICT updates/no-ops.
   -- Reuse only an already existing, complete unique historical link.
   -- Lock it so a concurrent delete cannot turn this into a new association.
   if tg_op='INSERT' and tg_table_schema='public' then
    if tg_table_name='stock_receipt_customers' then
     perform 1 from public.stock_receipt_customers r where r.stock_receipt_id=new.stock_receipt_id and r.customer_id=new.customer_id for key share;
     if found then return new; end if;
    elsif tg_table_name='equipment_registry' then
     perform 1 from public.equipment_registry r where r.source_table=new.source_table and r.source_id=new.source_id and r.customer_id=new.customer_id for key share;
     if found then return new; end if;
    elsif tg_table_name='customer_contract_services' then
     perform 1 from public.customer_contract_services r where r.customer_id=new.customer_id and r.service_type_id=new.service_type_id for key share;
     if found then return new; end if;
    end if;
   end if;
   raise exception '客戶已封存或不存在，請選擇有效客戶；原有歷史關聯仍保留。';
  end if;
 end if;
 return new;
end;
$$;
revoke all on function public.require_active_customer_link_v1() from public,anon,authenticated;
grant execute on function public.require_active_customer_link_v1() to service_role;
do $$ declare r record; begin
 for r in select distinct c.conrelid::regclass as tab from pg_constraint c
 join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
 where c.contype='f' and c.confrelid='public.customers'::regclass and a.attname='customer_id'
 loop
  execute format('create trigger require_active_customer_link before insert or update of customer_id on %s for each row execute function public.require_active_customer_link_v1()',r.tab);
 end loop;
end $$;

-- Extend the existing permission model. No non-admin grants are added implicitly.
do $$ declare prior text; begin
 select pg_get_constraintdef(oid) into prior from pg_constraint where conrelid='public.role_permissions'::regclass and conname='role_permissions_module_check';
 if prior is null then raise exception 'Missing existing role permission module constraint'; end if;
 alter table public.role_permissions drop constraint role_permissions_module_check;
 execute 'alter table public.role_permissions add constraint role_permissions_module_check check ('||substring(prior from 7)||' or module in (''data_export'',''quotation_invoices'',''system_backups''))';
end $$;

commit;
