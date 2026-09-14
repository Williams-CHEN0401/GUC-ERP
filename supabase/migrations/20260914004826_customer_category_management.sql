-- Lookup only: preserve customers.customer_category codes, customer UUIDs and every relationship.
-- New APIs remain service-role-only behind the existing customer RBAC gateway.
begin;

create table public.customer_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('custom_' || replace(gen_random_uuid()::text, '-', '')),
  name text not null check (char_length(btrim(name)) between 1 and 80 and name=btrim(name)),
  sort_order integer not null default 1000,
  row_version integer not null default 1 check (row_version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint customer_categories_code_check check (code ~ '^[a-z][a-z0-9_]{1,63}$')
);
create unique index customer_categories_name_ci_uidx on public.customer_categories(lower(btrim(name)));
alter table public.customer_categories enable row level security;
revoke all on public.customer_categories from public, anon, authenticated;
grant select,insert,update,delete on public.customer_categories to service_role;

insert into public.customer_categories(code,name,sort_order) values
 ('school','學校機關',10),('government','政府機關',20),
 ('social_welfare','社福機關',30),('cleaning_team','清潔隊',40);

-- Fail rather than reclassify any unexpected legacy codes.
alter table public.customers drop constraint customers_customer_category_check;
alter table public.customers add constraint customers_customer_category_fkey
 foreign key(customer_category) references public.customer_categories(code) on update restrict on delete restrict;
create index if not exists customers_customer_category_idx on public.customers(customer_category);

create function public.version_customer_category_v1() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
 if new.code is distinct from old.code or new.id is distinct from old.id then
   raise exception '客戶分類代碼不可變更，請修改分類名稱。';
 end if;
 new.row_version=old.row_version+1;
 new.updated_at=now();
 return new;
end $$;
revoke all on function public.version_customer_category_v1() from public,anon,authenticated;
grant execute on function public.version_customer_category_v1() to service_role;
create trigger customer_categories_version before update on public.customer_categories
 for each row execute function public.version_customer_category_v1();
-- Reuse trusted actor enrichment, existing audit format and redaction.
create trigger customer_categories_context_audit after insert or update or delete on public.customer_categories
 for each row execute function audit_internal.capture_links();

create function public.manage_customer_category_v1(
 p_action text,p_id uuid,p_row_version integer,p_name text,p_actor text
) returns public.customer_categories
language plpgsql security invoker set search_path = '' as $$
declare
 v_existing public.customer_categories;
 v_result public.customer_categories;
 v_name text=btrim(coalesce(p_name,''));
begin
 if p_action is null or p_action not in ('create','update','delete') then
   raise exception '不支援的客戶分類操作。';
 end if;
 if p_action<>'delete' and char_length(v_name) not between 1 and 80 then
   raise exception '分類名稱須為 1–80 個字。';
 end if;
 perform pg_catalog.set_config('app.actor',coalesce(p_actor,''),true);
 if p_action<>'create' then
   select * into v_existing from public.customer_categories where id=p_id for update;
   if not found or p_row_version is null or v_existing.row_version<>p_row_version then
     raise exception '此客戶分類已被更新或刪除，請重新載入後再操作。';
   end if;
 end if;
 if p_action='create' then
   insert into public.customer_categories(name,updated_by) values(v_name,p_actor) returning * into v_result;
 elsif p_action='update' then
   update public.customer_categories set name=v_name,updated_by=p_actor where id=p_id returning * into v_result;
 else
   if exists(select 1 from public.customers where customer_category=v_existing.code
     or (customer_category is null and v_existing.code='government')) then
     raise exception '此分類仍有客戶使用，請先將客戶改為其他分類。';
   end if;
   delete from public.customer_categories where id=p_id returning * into v_result;
 end if;
 return v_result;
exception
 when unique_violation then raise exception '此客戶分類名稱已存在。';
 when foreign_key_violation then raise exception '此分類仍有客戶使用，請先將客戶改為其他分類。';
end $$;
revoke all on function public.manage_customer_category_v1(text,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.manage_customer_category_v1(text,uuid,integer,text,text) to service_role;

-- Preserve the existing numbering, contract wrapper and permissions; replace only membership validation.
create or replace function public.create_customer_auto_number_v2(
  p_customer_category text,
  p_name text,
  p_phone text,
  p_email text,
  p_address text,
  p_note text,
  p_actor text
)
returns public.customers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result public.customers;
  v_number bigint;
begin
  if not exists (select 1 from public.customer_categories where code = p_customer_category) then
    raise exception '請選擇有效的客戶分類。';
  end if;
  if nullif(btrim(p_name), '') is null then
    raise exception '請輸入客戶名稱。';
  end if;

  v_number := public.next_business_number_value_v1('customer');
  if v_number > 999 then
    raise exception '客戶編號已達 C999，請聯絡管理者調整編號規則。';
  end if;

  insert into public.customers(
    customer_code, customer_category, name, phone, email, address, note, source, updated_by
  )
  values (
    'C' || lpad(v_number::text, 3, '0'),
    p_customer_category,
    btrim(p_name),
    nullif(btrim(p_phone), ''),
    nullif(btrim(p_email), ''),
    nullif(btrim(p_address), ''),
    nullif(btrim(p_note), ''),
    'web',
    p_actor
  )
  returning * into v_result;

  return v_result;
end;
$$;
revoke all on function public.create_customer_auto_number_v2(text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.create_customer_auto_number_v2(text,text,text,text,text,text,text) to service_role;
commit;
