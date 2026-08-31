begin;

alter table public.customers
  drop constraint if exists customers_customer_category_check;

alter table public.customers
  add constraint customers_customer_category_check
  check (
    customer_category is null
    or customer_category in ('school', 'government', 'social_welfare', 'cleaning_team')
  );

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
  if p_customer_category not in ('school', 'government', 'social_welfare', 'cleaning_team') then
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

revoke all on function public.create_customer_auto_number_v2(
  text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_customer_auto_number_v2(
  text, text, text, text, text, text, text
) to service_role;

do $$
begin
  if exists (
    select 1
    from public.customers
    where name like '%社福%'
      and name like '%清潔隊%'
  ) then
    raise exception '客戶名稱同時包含社福與清潔隊，無法自動判定分類。';
  end if;
end;
$$;

update public.customers
set customer_category = 'social_welfare',
    updated_by = 'customer_category_migration'
where name like '%社福%'
  and customer_category is distinct from 'social_welfare';

update public.customers
set customer_category = 'cleaning_team',
    updated_by = 'customer_category_migration'
where name like '%清潔隊%'
  and customer_category is distinct from 'cleaning_team';

do $$
begin
  if exists (
    select 1
    from public.customers
    where (name like '%社福%' and customer_category is distinct from 'social_welfare')
       or (name like '%清潔隊%' and customer_category is distinct from 'cleaning_team')
  ) then
    raise exception '客戶分類資料校正未完整完成。';
  end if;
end;
$$;

commit;
