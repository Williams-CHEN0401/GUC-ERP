-- Allow administrators to add inventory categories through the trusted gateway.
-- Existing categories, numbering rules, and inventory rows are not modified.

create or replace function public.create_product_category_v1(
  p_name text,
  p_code_prefix text,
  p_actor text
)
returns public.product_categories
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_code_prefix text := upper(btrim(coalesce(p_code_prefix, '')));
  v_result public.product_categories;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception '貨品種類名稱須為 1–80 個字。';
  end if;

  if v_code_prefix !~ '^[A-Z]{1,3}$' then
    raise exception '編號字首限 1–3 個英文字母。';
  end if;

  -- Serialize equal normalized names so concurrent requests receive a clear
  -- duplicate error instead of racing the case-insensitive unique index.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('product-category:' || lower(v_name), 0)
  );

  if exists (
    select 1
    from public.product_categories
    where lower(btrim(name)) = lower(v_name)
  ) then
    raise exception '此貨品種類名稱已存在。';
  end if;

  insert into public.product_categories (
    name,
    code_prefix,
    is_active,
    source,
    updated_by
  )
  values (
    v_name,
    v_code_prefix,
    true,
    'web',
    nullif(btrim(coalesce(p_actor, '')), '')
  )
  returning * into v_result;

  insert into public.audit_logs (
    entity_type,
    entity_id,
    action,
    before_data,
    after_data,
    source,
    actor
  )
  values (
    'product_category',
    v_result.id,
    'CREATE_PRODUCT_CATEGORY',
    null,
    to_jsonb(v_result),
    'web',
    nullif(btrim(coalesce(p_actor, '')), '')
  );

  return v_result;
exception
  when unique_violation then
    raise exception '此貨品種類名稱已存在。';
end;
$$;

revoke all on function public.create_product_category_v1(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_product_category_v1(text, text, text)
  to service_role;

comment on function public.create_product_category_v1(text, text, text) is
  'Creates an active product category through the service-role gateway and records an audit event.';
