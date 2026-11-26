-- Synthetic, isolated baseline for update_transaction_inline_items_v1.
-- Item master creation uses the real create_inventory_items_batch_v1 (loaded by
-- the runner from its migration). Permissions and the two document writers are
-- small recorders: the writers are covered by their own regression scripts.
create extension if not exists pgcrypto;
do $$begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin;end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin;end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin;end if;
end$$;
grant usage on schema public to anon,authenticated,service_role;

create table public.app_users(id uuid primary key,username text not null unique,is_active boolean not null default true);
create table public.test_grants(user_id uuid,module text,action text,primary key(user_id,module,action));
create table public.product_categories(id uuid primary key,name text not null,code_prefix text not null,is_active boolean not null default true);
create table public.inventory_items(
 id uuid primary key default gen_random_uuid(),inventory_code text not null unique,category_id uuid not null references public.product_categories(id),
 item_type text,model text,brand text not null,item_name text not null,unit text not null,opening_quantity numeric not null default 0,
 opening_meters numeric not null default 0,meters_per_unit numeric,source text,updated_by text);
create table public.test_numbers(scope text primary key,value bigint not null);
create table public.test_writer_calls(id bigserial primary key,kind text not null,document_id uuid not null,rows jsonb not null,args jsonb not null);

create function public.has_app_permission_v1(p_user_id uuid,p_module text,p_action text) returns boolean
language sql stable set search_path='' as $$select exists(select 1 from public.test_grants where user_id=p_user_id and module=p_module and action=p_action)$$;
create function public.erp_private_prepare_v1(p_user_id uuid) returns void language sql set search_path='' as $$select$$;
create function public.next_business_number_value_v1(p_scope text) returns bigint language sql set search_path='' as $$
 insert into public.test_numbers(scope,value) values(p_scope,1) on conflict(scope) do update set value=public.test_numbers.value+1 returning value$$;

-- Writers: record the resolved rows, and reject a stale version like the real writers.
create function public.save_pickup_document_v1(p_document_id uuid,p_existing jsonb,p_pickup_date date,p_project_id uuid,p_rows jsonb,p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from jsonb_array_elements(p_existing) e where (e->>'row_version')::int<>1) then raise exception '取貨單已被更新，請重新整理。';end if;
 insert into public.test_writer_calls(kind,document_id,rows,args) values('pickup',p_document_id,p_rows,jsonb_build_object('existing',p_existing,'date',p_pickup_date,'project',p_project_id,'actor',p_actor_user_id));
 return jsonb_build_object('document_id',p_document_id,'rows',p_rows);
end $$;
create function public.save_stock_receipt_document_v5(p_document_id uuid,p_create boolean,p_existing jsonb,p_receipt_date date,p_supplier_id uuid,p_rows jsonb,p_customer_ids uuid[],p_customer_departments jsonb,p_actor_user_id uuid,p_document_no text default null,p_metadata jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from jsonb_array_elements(p_existing) e where (e->>'row_version')::int<>1) then raise exception '進貨單已被更新，請重新整理。';end if;
 insert into public.test_writer_calls(kind,document_id,rows,args) values('receipt',p_document_id,p_rows,jsonb_build_object('create',p_create,'existing',p_existing,'date',p_receipt_date,
  'supplier',p_supplier_id,'customers',to_jsonb(p_customer_ids),'departments',p_customer_departments,'actor',p_actor_user_id,'document_no',p_document_no,'metadata',p_metadata));
 return jsonb_build_object('document_id',p_document_id,'rows',p_rows);
end $$;
