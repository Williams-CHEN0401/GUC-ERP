-- GUC quotation management system
-- Reuses canonical app_users, customers and projects. No duplicate master data.

do $$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.app_users') is null then v_missing := array_append(v_missing, 'public.app_users'); end if;
  if to_regclass('public.customers') is null then v_missing := array_append(v_missing, 'public.customers'); end if;
  if to_regclass('public.projects') is null then v_missing := array_append(v_missing, 'public.projects'); end if;
  if to_regclass('public.customer_contacts') is null then v_missing := array_append(v_missing, 'public.customer_contacts'); end if;
  if to_regprocedure('public.increment_row_version()') is null then v_missing := array_append(v_missing, 'public.increment_row_version()'); end if;
  if to_regprocedure('public.next_business_number_value_v1(text)') is null then v_missing := array_append(v_missing, 'public.next_business_number_value_v1(text)'); end if;

  if cardinality(v_missing) > 0 then
    raise exception 'Quotation migration prerequisites are missing: %', array_to_string(v_missing, ', ');
  end if;
end $$;

create table if not exists public.quotation_access_users (
  app_user_id uuid primary key references public.app_users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by_user_id uuid references public.app_users(id) on delete set null,
  note text,
  constraint quotation_access_users_note_length check (note is null or char_length(note) <= 500)
);

do $$
declare
  v_seeded integer;
  v_total integer;
begin
  insert into public.quotation_access_users(app_user_id, note)
  select id, 'Initial quotation-system access'
  from public.app_users
  where is_active = true
    and lower(username) in ('williams', 'joyce', 'chent8241')
  on conflict (app_user_id) do nothing;

  select count(*) into v_seeded
  from public.quotation_access_users access
  join public.app_users users on users.id = access.app_user_id
  where users.is_active = true
    and lower(users.username) in ('williams', 'joyce', 'chent8241');

  select count(*) into v_total from public.quotation_access_users;

  if v_seeded <> 3 or v_total <> 3 then
    raise exception 'Expected exactly Williams, Joyce and 老闆 in the initial quotation access list; matched %, total %.', v_seeded, v_total;
  end if;
end $$;

create table if not exists public.quotations (
  id uuid primary key default gen_random_uuid(),
  quotation_number text not null unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  current_version_id uuid,
  owner_user_id uuid not null references public.app_users(id) on delete restrict,
  quote_status text not null default 'draft',
  billing_status text not null default 'unbilled',
  quote_status_updated_at timestamptz not null default now(),
  billing_status_updated_at timestamptz not null default now(),
  created_by_user_id uuid not null references public.app_users(id) on delete restrict,
  updated_by_user_id uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  voided_at timestamptz,
  voided_by_user_id uuid references public.app_users(id) on delete restrict,
  void_reason text,
  archived_at timestamptz,
  archived_by_user_id uuid references public.app_users(id) on delete restrict,
  archive_reason text,
  constraint quotations_number_format check (quotation_number ~ '^Q[0-9]{8}$'),
  constraint quotations_quote_status_check check (quote_status in ('draft','completed','sent','confirmed','lost','won','voided')),
  constraint quotations_billing_status_check check (billing_status in ('unbilled','preparing','in_progress','partial','completed')),
  constraint quotations_billing_requires_won_check check (billing_status = 'unbilled' or quote_status = 'won'),
  constraint quotations_row_version_check check (row_version >= 1),
  constraint quotations_void_reason_length check (void_reason is null or char_length(void_reason) <= 1000),
  constraint quotations_archive_reason_length check (archive_reason is null or char_length(archive_reason) <= 1000),
  constraint quotations_void_fields_check check (
    (quote_status <> 'voided' and voided_at is null and voided_by_user_id is null and void_reason is null)
    or
    (quote_status = 'voided' and voided_at is not null and voided_by_user_id is not null and nullif(btrim(void_reason), '') is not null)
  ),
  constraint quotations_archive_fields_check check (
    (archived_at is null and archived_by_user_id is null and archive_reason is null)
    or
    (archived_at is not null and archived_by_user_id is not null and nullif(btrim(archive_reason), '') is not null)
  )
);

create table if not exists public.quotation_versions (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.quotations(id) on delete restrict,
  version_number integer not null,
  is_current boolean not null default true,
  quote_date date not null,
  valid_until date not null,
  contact_id uuid references public.customer_contacts(id) on delete set null,
  customer_code_snapshot text,
  customer_name_snapshot text not null,
  customer_phone_snapshot text,
  customer_email_snapshot text,
  customer_address_snapshot text,
  contact_name_snapshot text,
  contact_title_snapshot text,
  contact_phone_snapshot text,
  contact_email_snapshot text,
  project_code_snapshot text,
  project_name_snapshot text not null,
  subtotal_twd bigint not null default 0,
  discount_twd bigint not null default 0,
  tax_rate_basis_points integer not null default 500,
  tax_twd bigint not null default 0,
  total_twd bigint not null default 0,
  note text,
  created_by_user_id uuid not null references public.app_users(id) on delete restrict,
  updated_by_user_id uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1,
  constraint quotation_versions_number_check check (version_number >= 1),
  constraint quotation_versions_dates_check check (valid_until >= quote_date),
  constraint quotation_versions_subtotal_check check (subtotal_twd between 0 and 9000000000000000),
  constraint quotation_versions_discount_check check (discount_twd between 0 and 9000000000000000 and discount_twd <= subtotal_twd),
  constraint quotation_versions_tax_rate_check check (tax_rate_basis_points between 0 and 10000),
  constraint quotation_versions_tax_check check (tax_twd between 0 and 9000000000000000),
  constraint quotation_versions_total_check check (total_twd = subtotal_twd - discount_twd + tax_twd and total_twd between 0 and 9000000000000000),
  constraint quotation_versions_note_length check (note is null or char_length(note) <= 4000),
  constraint quotation_versions_row_version_check check (row_version >= 1),
  constraint quotation_versions_quotation_number_uidx unique (quotation_id, version_number),
  constraint quotation_versions_quotation_id_id_uidx unique (quotation_id, id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quotations_current_version_same_quotation_fkey'
      and conrelid = 'public.quotations'::regclass
  ) then
    alter table public.quotations
      add constraint quotations_current_version_same_quotation_fkey
      foreign key (id, current_version_id)
      references public.quotation_versions(quotation_id, id)
      on delete restrict
      deferrable initially deferred;
  end if;
end $$;

create table if not exists public.quotation_items (
  id uuid primary key default gen_random_uuid(),
  quotation_version_id uuid not null,
  line_number integer not null,
  description text not null,
  specification text,
  quantity_milli bigint not null,
  unit text not null,
  unit_price_twd bigint not null,
  line_subtotal_twd bigint generated always as (
    round((quantity_milli::numeric * unit_price_twd::numeric) / 1000)::bigint
  ) stored,
  note text,
  created_at timestamptz not null default now(),
  constraint quotation_items_line_number_check check (line_number between 1 and 100),
  constraint quotation_items_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint quotation_items_specification_length check (specification is null or char_length(specification) <= 500),
  constraint quotation_items_quantity_check check (quantity_milli between 1 and 1000000000),
  constraint quotation_items_unit_length check (char_length(btrim(unit)) between 1 and 32),
  constraint quotation_items_unit_price_check check (unit_price_twd between 0 and 1000000000),
  constraint quotation_items_line_subtotal_check check (line_subtotal_twd between 0 and 90000000000000),
  constraint quotation_items_note_length check (note is null or char_length(note) <= 500),
  constraint quotation_items_version_line_uidx unique (quotation_version_id, line_number)
);

create table if not exists public.quotation_status_history (
  id bigint generated always as identity primary key,
  quotation_id uuid not null references public.quotations(id) on delete restrict,
  quotation_version_id uuid not null references public.quotation_versions(id) on delete restrict,
  from_status text,
  to_status text not null,
  note text,
  changed_by_user_id uuid not null references public.app_users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  constraint quotation_status_history_version_fkey foreign key (quotation_id, quotation_version_id) references public.quotation_versions(quotation_id, id) on delete restrict,
  constraint quotation_status_history_from_check check (from_status is null or from_status in ('draft','completed','sent','confirmed','lost','won','voided')),
  constraint quotation_status_history_to_check check (to_status in ('draft','completed','sent','confirmed','lost','won','voided','archived')),
  constraint quotation_status_history_note_length check (note is null or char_length(note) <= 1000)
);

create table if not exists public.quotation_billing_history (
  id bigint generated always as identity primary key,
  quotation_id uuid not null references public.quotations(id) on delete restrict,
  from_status text,
  to_status text not null,
  note text,
  changed_by_user_id uuid not null references public.app_users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  constraint quotation_billing_history_from_check check (from_status is null or from_status in ('unbilled','preparing','in_progress','partial','completed')),
  constraint quotation_billing_history_to_check check (to_status in ('unbilled','preparing','in_progress','partial','completed')),
  constraint quotation_billing_history_note_length check (note is null or char_length(note) <= 1000)
);

create table if not exists public.quotation_audit_log (
  id bigint generated always as identity primary key,
  quotation_id uuid not null references public.quotations(id) on delete restrict,
  quotation_version_id uuid,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  actor_user_id uuid not null references public.app_users(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  constraint quotation_audit_log_version_fkey foreign key (quotation_id, quotation_version_id) references public.quotation_versions(quotation_id, id) on delete restrict,
  constraint quotation_audit_log_action_check check (action in ('create','update','create_version','quote_status','billing_status','void','archive')),
  constraint quotation_audit_log_payload_check check (before_data is not null or after_data is not null)
);

create index if not exists quotations_customer_updated_idx
  on public.quotations(customer_id, updated_at desc, id desc)
  where archived_at is null;
create index if not exists quotations_project_updated_idx
  on public.quotations(project_id, updated_at desc, id desc)
  where project_id is not null and archived_at is null;
create unique index if not exists quotations_project_active_uidx
  on public.quotations(project_id)
  where archived_at is null and quote_status <> 'voided';
create index if not exists quotations_quote_status_updated_idx
  on public.quotations(quote_status, updated_at desc, id desc)
  where archived_at is null;
create index if not exists quotations_billing_status_updated_idx
  on public.quotations(billing_status, updated_at desc, id desc)
  where archived_at is null;
create index if not exists quotations_owner_user_id_idx on public.quotations(owner_user_id);
create index if not exists quotations_customer_id_idx on public.quotations(customer_id);
create index if not exists quotations_project_id_idx on public.quotations(project_id) where project_id is not null;
create index if not exists quotations_active_updated_idx on public.quotations(updated_at desc, id desc) where archived_at is null;
create index if not exists quotation_access_users_granted_by_idx on public.quotation_access_users(granted_by_user_id) where granted_by_user_id is not null;
create index if not exists quotations_created_by_user_id_idx on public.quotations(created_by_user_id);
create index if not exists quotations_updated_by_user_id_idx on public.quotations(updated_by_user_id);
create index if not exists quotations_voided_by_user_id_idx on public.quotations(voided_by_user_id) where voided_by_user_id is not null;
create index if not exists quotations_archived_by_user_id_idx on public.quotations(archived_by_user_id) where archived_by_user_id is not null;
create unique index if not exists quotation_versions_one_current_uidx
  on public.quotation_versions(quotation_id)
  where is_current = true;
create index if not exists quotation_versions_contact_id_idx on public.quotation_versions(contact_id) where contact_id is not null;
create index if not exists quotation_versions_created_by_user_id_idx on public.quotation_versions(created_by_user_id);
create index if not exists quotation_versions_updated_by_user_id_idx on public.quotation_versions(updated_by_user_id);
create index if not exists quotation_status_history_quotation_idx on public.quotation_status_history(quotation_id, changed_at desc, id desc);
create index if not exists quotation_status_history_version_idx on public.quotation_status_history(quotation_version_id, changed_at desc, id desc);
create index if not exists quotation_status_history_user_idx on public.quotation_status_history(changed_by_user_id);
create index if not exists quotation_billing_history_quotation_idx on public.quotation_billing_history(quotation_id, changed_at desc, id desc);
create index if not exists quotation_billing_history_user_idx on public.quotation_billing_history(changed_by_user_id);
create index if not exists quotation_audit_log_quotation_idx on public.quotation_audit_log(quotation_id, occurred_at desc, id desc);
create index if not exists quotation_audit_log_version_idx on public.quotation_audit_log(quotation_version_id) where quotation_version_id is not null;
create index if not exists quotation_audit_log_actor_idx on public.quotation_audit_log(actor_user_id, occurred_at desc);

create or replace function public.quotation_assert_current_version_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.quotations;
  v_quote_id uuid;
  v_current_count integer;
  v_pointer_is_current boolean;
begin
  if tg_table_name = 'quotations' then
    v_quote_id := new.id;
  elsif tg_op = 'DELETE' then
    v_quote_id := old.quotation_id;
  else
    v_quote_id := new.quotation_id;
  end if;

  select * into v_quote
  from public.quotations
  where id = v_quote_id;

  if not found then
    return null;
  end if;

  select count(*), coalesce(bool_or(version.id = v_quote.current_version_id and version.is_current), false)
  into v_current_count, v_pointer_is_current
  from public.quotation_versions version
  where version.quotation_id = v_quote.id
    and version.is_current;

  if v_quote.current_version_id is null
     or v_current_count <> 1
     or not v_pointer_is_current then
    raise exception '報價目前版本指標不一致。';
  end if;

  return null;
end;
$$;

drop trigger if exists quotations_assert_current_version on public.quotations;
create constraint trigger quotations_assert_current_version
after insert or update of current_version_id on public.quotations
deferrable initially deferred
for each row
execute function public.quotation_assert_current_version_v1();

drop trigger if exists quotation_versions_assert_current_version on public.quotation_versions;
create constraint trigger quotation_versions_assert_current_version
after insert or update or delete on public.quotation_versions
deferrable initially deferred
for each row
execute function public.quotation_assert_current_version_v1();

drop trigger if exists quotations_increment_row_version on public.quotations;
create trigger quotations_increment_row_version
before update on public.quotations for each row
execute function public.increment_row_version();

drop trigger if exists quotation_versions_increment_row_version on public.quotation_versions;
create trigger quotation_versions_increment_row_version
before update on public.quotation_versions for each row
execute function public.increment_row_version();

create or replace function public.quotation_require_access_v1(p_actor_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not exists (
    select 1
    from public.quotation_access_users access
    join public.app_users users on users.id = access.app_user_id
    where access.app_user_id = p_actor_user_id
      and users.is_active = true
  ) then
    raise exception '您沒有執行報價管理系統的權限。';
  end if;
end;
$$;

create or replace function public.quotation_insert_items_v1(
  p_quotation_version_id uuid,
  p_items jsonb,
  p_discount_twd bigint,
  p_tax_rate_basis_points integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_line integer := 0;
  v_description text;
  v_specification text;
  v_unit text;
  v_note text;
  v_quantity_milli bigint;
  v_unit_price_twd bigint;
  v_subtotal_twd bigint;
  v_tax_twd bigint;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception '報價明細必須為 JSON 陣列。';
  end if;
  if jsonb_array_length(p_items) not between 1 and 100 then
    raise exception '報價明細必須包含 1 至 100 筆。';
  end if;
  if p_discount_twd is null or p_discount_twd < 0 then
    raise exception '折扣金額不可小於零。';
  end if;
  if p_tax_rate_basis_points is null or p_tax_rate_basis_points not between 0 and 10000 then
    raise exception '稅率格式不正確。';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_line := v_line + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception '第 % 筆報價明細格式不正確。', v_line;
    end if;
    v_description := btrim(coalesce(v_item ->> 'description', ''));
    v_specification := nullif(btrim(coalesce(v_item ->> 'specification', '')), '');
    v_unit := btrim(coalesce(v_item ->> 'unit', ''));
    v_note := nullif(btrim(coalesce(v_item ->> 'note', '')), '');
    if coalesce(jsonb_typeof(v_item -> 'description'), '') <> 'string'
       or coalesce(jsonb_typeof(v_item -> 'unit'), '') <> 'string'
       or coalesce(jsonb_typeof(v_item -> 'quantity_milli'), '') not in ('number', 'string')
       or coalesce(jsonb_typeof(v_item -> 'unit_price_twd'), '') not in ('number', 'string')
       or (v_item ? 'specification' and jsonb_typeof(v_item -> 'specification') not in ('string', 'null'))
       or (v_item ? 'note' and jsonb_typeof(v_item -> 'note') not in ('string', 'null'))
       or char_length(v_description) not between 1 and 500
       or (v_specification is not null and char_length(v_specification) > 500)
       or char_length(v_unit) not between 1 and 32
       or (v_note is not null and char_length(v_note) > 500)
       or coalesce(v_item ->> 'quantity_milli', '') !~ '^[0-9]+$'
       or coalesce(v_item ->> 'unit_price_twd', '') !~ '^[0-9]+$'
       or char_length(coalesce(v_item ->> 'quantity_milli', '')) > 10
       or char_length(coalesce(v_item ->> 'unit_price_twd', '')) > 10 then
      raise exception '第 % 筆報價明細不完整或超過長度限制。', v_line;
    end if;
    v_quantity_milli := (v_item ->> 'quantity_milli')::bigint;
    v_unit_price_twd := (v_item ->> 'unit_price_twd')::bigint;
    if v_quantity_milli not between 1 and 1000000000
       or v_unit_price_twd not between 0 and 1000000000 then
      raise exception '第 % 筆數量或單價超過允許範圍。', v_line;
    end if;
    if round((v_quantity_milli::numeric * v_unit_price_twd::numeric) / 1000) > 90000000000000 then
      raise exception '第 % 筆金額超過允許範圍。', v_line;
    end if;
    insert into public.quotation_items(
      quotation_version_id, line_number, description, specification, quantity_milli,
      unit, unit_price_twd, note
    ) values (
      p_quotation_version_id, v_line, v_description, v_specification, v_quantity_milli,
      v_unit, v_unit_price_twd, v_note
    );
  end loop;

  select coalesce(sum(line_subtotal_twd), 0)::bigint into v_subtotal_twd
  from public.quotation_items
  where quotation_version_id = p_quotation_version_id;

  if p_discount_twd > v_subtotal_twd then
    raise exception '折扣金額不可超過小計。';
  end if;
  if v_subtotal_twd > 9000000000000000 then
    raise exception '報價總額超過允許範圍。';
  end if;
  v_tax_twd := round(((v_subtotal_twd - p_discount_twd)::numeric * p_tax_rate_basis_points::numeric) / 10000)::bigint;
  if v_subtotal_twd - p_discount_twd + v_tax_twd > 9000000000000000 then
    raise exception '報價總額超過允許範圍。';
  end if;
  update public.quotation_versions
  set subtotal_twd = v_subtotal_twd,
      discount_twd = p_discount_twd,
      tax_rate_basis_points = p_tax_rate_basis_points,
      tax_twd = v_tax_twd,
      total_twd = v_subtotal_twd - p_discount_twd + v_tax_twd
  where id = p_quotation_version_id;
end;
$$;

create or replace function public.quotation_write_audit_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid,
  p_quotation_version_id uuid,
  p_action text,
  p_before_data jsonb,
  p_after_data jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  if p_action not in ('create','update','create_version','quote_status','billing_status','void','archive') then
    raise exception '報價稽核動作不正確。';
  end if;
  insert into public.quotation_audit_log(
    quotation_id, quotation_version_id, action, before_data, after_data, actor_user_id
  ) values (
    p_quotation_id, p_quotation_version_id, p_action, p_before_data, p_after_data, p_actor_user_id
  );
end;
$$;

create or replace function public.quotation_detail_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  select jsonb_build_object(
    'quotation', jsonb_build_object(
      'id', q.id,
      'quotation_number', q.quotation_number,
      'customer_id', q.customer_id,
      'project_id', q.project_id,
      'owner_user_id', q.owner_user_id,
      'owner_name', owner.display_name,
      'quote_status', q.quote_status,
      'billing_status', q.billing_status,
      'quote_status_updated_at', q.quote_status_updated_at,
      'billing_status_updated_at', q.billing_status_updated_at,
      'created_by_user_id', q.created_by_user_id,
      'created_by_name', creator.display_name,
      'created_at', q.created_at,
      'updated_at', q.updated_at,
      'row_version', q.row_version,
      'voided_at', q.voided_at,
      'void_reason', q.void_reason
    ),
    'current_version', jsonb_build_object(
      'id', version.id,
      'version_number', version.version_number,
      'quote_date', version.quote_date,
      'valid_until', version.valid_until,
      'contact_id', version.contact_id,
      'customer_code_snapshot', version.customer_code_snapshot,
      'customer_name_snapshot', version.customer_name_snapshot,
      'customer_phone_snapshot', version.customer_phone_snapshot,
      'customer_email_snapshot', version.customer_email_snapshot,
      'customer_address_snapshot', version.customer_address_snapshot,
      'contact_name_snapshot', version.contact_name_snapshot,
      'contact_title_snapshot', version.contact_title_snapshot,
      'contact_phone_snapshot', version.contact_phone_snapshot,
      'contact_email_snapshot', version.contact_email_snapshot,
      'project_code_snapshot', version.project_code_snapshot,
      'project_name_snapshot', version.project_name_snapshot,
      'subtotal_twd', version.subtotal_twd,
      'discount_twd', version.discount_twd,
      'tax_rate_basis_points', version.tax_rate_basis_points,
      'tax_twd', version.tax_twd,
      'total_twd', version.total_twd,
      'note', version.note,
      'created_at', version.created_at,
      'updated_at', version.updated_at,
      'row_version', version.row_version
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'line_number', item.line_number,
        'description', item.description,
        'specification', item.specification,
        'quantity_milli', item.quantity_milli,
        'unit', item.unit,
        'unit_price_twd', item.unit_price_twd,
        'line_subtotal_twd', item.line_subtotal_twd,
        'note', item.note
      ) order by item.line_number)
      from public.quotation_items item
      where item.quotation_version_id = version.id
    ), '[]'::jsonb),
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', history.id,
        'version_number', history.version_number,
        'is_current', history.is_current,
        'quote_date', history.quote_date,
        'valid_until', history.valid_until,
        'total_twd', history.total_twd,
        'created_at', history.created_at,
        'created_by_name', history_creator.display_name
      ) order by history.version_number desc)
      from public.quotation_versions history
      join public.app_users history_creator on history_creator.id = history.created_by_user_id
      where history.quotation_id = q.id
    ), '[]'::jsonb),
    'quote_status_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', status_history.id,
        'quotation_version_id', status_history.quotation_version_id,
        'from_status', status_history.from_status,
        'to_status', status_history.to_status,
        'note', status_history.note,
        'changed_at', status_history.changed_at,
        'changed_by_name', status_user.display_name
      ) order by status_history.changed_at desc, status_history.id desc)
      from public.quotation_status_history status_history
      join public.app_users status_user on status_user.id = status_history.changed_by_user_id
      where status_history.quotation_id = q.id
    ), '[]'::jsonb),
    'billing_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', billing_history.id,
        'from_status', billing_history.from_status,
        'to_status', billing_history.to_status,
        'note', billing_history.note,
        'changed_at', billing_history.changed_at,
        'changed_by_name', billing_user.display_name
      ) order by billing_history.changed_at desc, billing_history.id desc)
      from public.quotation_billing_history billing_history
      join public.app_users billing_user on billing_user.id = billing_history.changed_by_user_id
      where billing_history.quotation_id = q.id
    ), '[]'::jsonb)
  ) into v_result
  from public.quotations q
  join public.quotation_versions version on version.id = q.current_version_id and version.quotation_id = q.id
  join public.app_users owner on owner.id = q.owner_user_id
  join public.app_users creator on creator.id = q.created_by_user_id
  where q.id = p_quotation_id
    and q.archived_at is null;

  if v_result is null then
    raise exception '找不到報價資料。';
  end if;
  return v_result;
end;
$$;

create or replace function public.quotation_version_detail_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid,
  p_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  select jsonb_build_object(
    'version', jsonb_build_object(
      'id', version.id,
      'version_number', version.version_number,
      'is_current', version.is_current,
      'quote_date', version.quote_date,
      'valid_until', version.valid_until,
      'contact_id', version.contact_id,
      'customer_code_snapshot', version.customer_code_snapshot,
      'customer_name_snapshot', version.customer_name_snapshot,
      'customer_phone_snapshot', version.customer_phone_snapshot,
      'customer_email_snapshot', version.customer_email_snapshot,
      'customer_address_snapshot', version.customer_address_snapshot,
      'contact_name_snapshot', version.contact_name_snapshot,
      'contact_title_snapshot', version.contact_title_snapshot,
      'contact_phone_snapshot', version.contact_phone_snapshot,
      'contact_email_snapshot', version.contact_email_snapshot,
      'project_code_snapshot', version.project_code_snapshot,
      'project_name_snapshot', version.project_name_snapshot,
      'subtotal_twd', version.subtotal_twd,
      'discount_twd', version.discount_twd,
      'tax_rate_basis_points', version.tax_rate_basis_points,
      'tax_twd', version.tax_twd,
      'total_twd', version.total_twd,
      'note', version.note,
      'created_at', version.created_at,
      'updated_at', version.updated_at,
      'row_version', version.row_version
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'line_number', item.line_number,
        'description', item.description,
        'specification', item.specification,
        'quantity_milli', item.quantity_milli,
        'unit', item.unit,
        'unit_price_twd', item.unit_price_twd,
        'line_subtotal_twd', item.line_subtotal_twd,
        'note', item.note
      ) order by item.line_number)
      from public.quotation_items item
      where item.quotation_version_id = version.id
    ), '[]'::jsonb),
    'status_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', history.id,
        'from_status', history.from_status,
        'to_status', history.to_status,
        'note', history.note,
        'changed_at', history.changed_at,
        'changed_by_name', actor.display_name
      ) order by history.changed_at desc, history.id desc)
      from public.quotation_status_history history
      join public.app_users actor on actor.id = history.changed_by_user_id
      where history.quotation_version_id = version.id
    ), '[]'::jsonb)
  ) into v_result
  from public.quotation_versions version
  where version.id = p_version_id
    and version.quotation_id = p_quotation_id;

  if v_result is null then raise exception '找不到報價版本。'; end if;
  return v_result;
end;
$$;

create or replace function public.quotation_options_v1(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  return jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', customer.id,
        'code', customer.customer_code,
        'name', customer.name,
        'phone', customer.phone,
        'email', customer.email,
        'address', customer.address
      ) order by customer.name)
      from public.customers customer
    ), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', project.id,
        'code', project.project_code,
        'name', project.name,
        'customer_id', project.customer_id,
        'status', project.status
      ) order by project.project_code nulls last, project.name)
      from public.projects project
    ), '[]'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', contact.id,
        'customer_id', contact.customer_id,
        'name', contact.name,
        'title', contact.title,
        'phone', contact.phone,
        'email', contact.email,
        'is_primary', contact.is_primary
      ) order by contact.customer_id, contact.is_primary desc, contact.name)
      from public.customer_contacts contact
    ), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object('id', users.id, 'display_name', users.display_name) order by users.display_name)
      from public.app_users users
      where users.is_active = true
    ), '[]'::jsonb),
    'settings', jsonb_build_object(
      'currency', 'TWD',
      'default_tax_rate_basis_points', 500,
      'quantity_scale', 3,
      'rounding', 'round_half_away_from_zero'
    )
  );
end;
$$;

create or replace function public.quotation_dashboard_v1(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  return jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'draft', count(*) filter (where quote_status = 'draft'),
        'sent', count(*) filter (where quote_status = 'sent'),
        'won', count(*) filter (where quote_status = 'won'),
        'pending_billing', count(*) filter (where quote_status = 'won' and billing_status <> 'completed'),
        'won_total_twd', coalesce(sum(version.total_twd) filter (where quote_status = 'won'), 0)::text
      )
      from public.quotations quote
      join public.quotation_versions version on version.id = quote.current_version_id
      where quote.archived_at is null
    ),
    'quote_status_counts', coalesce((
      select jsonb_object_agg(grouped.quote_status, grouped.total)
      from (
        select quote_status, count(*) total
        from public.quotations
        where archived_at is null
        group by quote_status
      ) grouped
    ), '{}'::jsonb),
    'billing_status_counts', coalesce((
      select jsonb_object_agg(grouped.billing_status, grouped.total)
      from (
        select billing_status, count(*) total
        from public.quotations
        where archived_at is null
        group by billing_status
      ) grouped
    ), '{}'::jsonb),
    'project_summary', (
      select jsonb_build_object(
        'total_projects', count(*),
        'unquoted_projects', count(*) filter (where latest_quote.id is null and project.status = 'in_progress'),
        'waiting_customer', count(*) filter (where latest_quote.quote_status = 'sent'),
        'won_projects', count(*) filter (where latest_quote.quote_status = 'won'),
        'pending_billing_projects', count(*) filter (where latest_quote.quote_status = 'won' and latest_quote.billing_status <> 'completed')
      )
      from public.projects project
      left join lateral (
        select quote.id, quote.quote_status, quote.billing_status
        from public.quotations quote
        where quote.project_id = project.id
          and quote.archived_at is null
        order by quote.updated_at desc, quote.id desc
        limit 1
      ) latest_quote on true
    ),
    'recent', coalesce((
      select jsonb_agg(to_jsonb(recent_row) order by recent_row.updated_at desc, recent_row.id desc)
      from (
        select quote.id, quote.quotation_number, quote.quote_status, quote.billing_status,
          quote.updated_at, version.customer_name_snapshot, version.project_name_snapshot,
          version.total_twd, version.version_number
        from public.quotations quote
        join public.quotation_versions version on version.id = quote.current_version_id
        where quote.archived_at is null
        order by quote.updated_at desc, quote.id desc
        limit 8
      ) recent_row
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.quotation_project_tracking_v1(
  p_actor_user_id uuid,
  p_search text default null,
  p_quote_status text default null,
  p_billing_status text default null,
  p_owner_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_result jsonb;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  if p_quote_status is not null and p_quote_status not in ('unquoted','unconfirmed','draft','completed','sent','confirmed','lost','won','voided') then
    raise exception '專案報價狀態篩選值不正確。';
  end if;
  if p_billing_status is not null and p_billing_status not in ('unbilled','preparing','in_progress','partial','completed') then
    raise exception '專案請款狀態篩選值不正確。';
  end if;

  select coalesce(jsonb_agg(to_jsonb(tracking_row) order by tracking_row.customer_name, tracking_row.project_code nulls last, tracking_row.project_name), '[]'::jsonb)
  into v_result
  from (
    select
      customer.id customer_id,
      customer.customer_code,
      customer.name customer_name,
      project.id project_id,
      project.project_code,
      project.name project_name,
      project.status project_status,
      latest_quote.id quotation_id,
      latest_quote.quotation_number,
      case when latest_quote.id is not null then latest_quote.quote_status
        when project.status = 'in_progress' then 'unquoted'
        else 'unconfirmed'
      end quote_status,
      latest_quote.billing_status,
      latest_quote.owner_user_id,
      latest_quote.owner_name,
      latest_quote.total_twd,
      coalesce(latest_quote.updated_at, project.updated_at) updated_at
    from public.projects project
    join public.customers customer on customer.id = project.customer_id
    left join lateral (
      select quote.id, quote.quotation_number, quote.quote_status, quote.billing_status,
        quote.owner_user_id, owner.display_name owner_name, version.total_twd, quote.updated_at
      from public.quotations quote
      join public.quotation_versions version on version.id = quote.current_version_id
      join public.app_users owner on owner.id = quote.owner_user_id
      where quote.project_id = project.id
        and quote.archived_at is null
      order by quote.updated_at desc, quote.id desc
      limit 1
    ) latest_quote on true
    where (
      v_search is null
      or customer.name ilike '%' || v_search || '%'
      or project.name ilike '%' || v_search || '%'
      or coalesce(project.project_code, '') ilike '%' || v_search || '%'
    )
      and (p_quote_status is null or case when latest_quote.id is not null then latest_quote.quote_status when project.status = 'in_progress' then 'unquoted' else 'unconfirmed' end = p_quote_status)
      and (p_billing_status is null or latest_quote.billing_status = p_billing_status)
      and (p_owner_user_id is null or latest_quote.owner_user_id = p_owner_user_id)
  ) tracking_row;
  return v_result;
end;
$$;

create or replace function public.quotation_list_v1(
  p_actor_user_id uuid,
  p_search text default null,
  p_quote_status text default null,
  p_billing_status text default null,
  p_customer_id uuid default null,
  p_project_id uuid default null,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_records jsonb;
  v_count integer;
  v_next_updated_at timestamptz;
  v_next_id uuid;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  if p_quote_status is not null and p_quote_status not in ('draft','completed','sent','confirmed','lost','won','voided') then
    raise exception '報價狀態篩選值不正確。';
  end if;
  if p_billing_status is not null and p_billing_status not in ('unbilled','preparing','in_progress','partial','completed') then
    raise exception '請款狀態篩選值不正確。';
  end if;
  if (p_cursor_updated_at is null) <> (p_cursor_id is null) then
    raise exception '分頁游標不完整。';
  end if;

  with quotation_page_rows as materialized (
    select quote.id, quote.quotation_number, quote.customer_id, quote.project_id,
      quote.owner_user_id, owner.display_name owner_name, quote.quote_status,
      quote.billing_status, quote.created_at, quote.updated_at, quote.row_version,
      version.id version_id, version.version_number, version.quote_date,
      version.valid_until, version.customer_code_snapshot, version.customer_name_snapshot,
      version.project_code_snapshot, version.project_name_snapshot, version.subtotal_twd,
      version.discount_twd, version.tax_twd, version.total_twd
    from public.quotations quote
    join public.quotation_versions version on version.id = quote.current_version_id
    join public.app_users owner on owner.id = quote.owner_user_id
    where quote.archived_at is null
      and (p_quote_status is null or quote.quote_status = p_quote_status)
      and (p_billing_status is null or quote.billing_status = p_billing_status)
      and (p_customer_id is null or quote.customer_id = p_customer_id)
      and (p_project_id is null or quote.project_id = p_project_id)
      and (
        v_search is null
        or quote.quotation_number ilike '%' || v_search || '%'
        or version.customer_name_snapshot ilike '%' || v_search || '%'
        or coalesce(version.project_name_snapshot, '') ilike '%' || v_search || '%'
      )
      and (
        p_cursor_updated_at is null
        or (quote.updated_at, quote.id) < (p_cursor_updated_at, p_cursor_id)
      )
    order by quote.updated_at desc, quote.id desc
    limit v_limit + 1
  )
  select
    (select count(*) from quotation_page_rows),
    (
      select coalesce(jsonb_agg(to_jsonb(page_row) order by page_row.updated_at desc, page_row.id desc), '[]'::jsonb)
      from (
        select * from quotation_page_rows
        order by updated_at desc, id desc
        limit v_limit
      ) page_row
    ),
    (
      select updated_at from quotation_page_rows
      order by updated_at desc, id desc
      offset v_limit - 1 limit 1
    ),
    (
      select id from quotation_page_rows
      order by updated_at desc, id desc
      offset v_limit - 1 limit 1
    )
  into v_count, v_records, v_next_updated_at, v_next_id;

  if v_count <= v_limit then
    v_next_updated_at := null;
    v_next_id := null;
  end if;

  return jsonb_build_object(
    'records', v_records,
    'next_cursor', case when v_next_id is null then null else jsonb_build_object('updated_at', v_next_updated_at, 'id', v_next_id) end
  );
end;
$$;

create or replace function public.create_quotation_v1(
  p_actor_user_id uuid,
  p_customer_id uuid,
  p_project_id uuid,
  p_owner_user_id uuid,
  p_contact_id uuid,
  p_quote_date date,
  p_valid_until date,
  p_discount_twd bigint,
  p_tax_rate_basis_points integer,
  p_note text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_project public.projects;
  v_contact public.customer_contacts;
  v_owner public.app_users;
  v_sequence bigint;
  v_number text;
  v_quotation_id uuid := gen_random_uuid();
  v_version_id uuid := gen_random_uuid();
  v_result jsonb;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  if p_quote_date is null or p_valid_until is null or p_valid_until < p_quote_date then
    raise exception '報價日期與有效期限不正確。';
  end if;
  if p_note is not null and char_length(p_note) > 4000 then
    raise exception '備註不可超過 4000 個字。';
  end if;
  select * into v_customer from public.customers where id = p_customer_id;
  if not found then raise exception '找不到客戶資料。'; end if;
  if p_project_id is null then raise exception '建立報價必須選擇專案。'; end if;
  select * into v_project from public.projects where id = p_project_id and customer_id = p_customer_id;
  if not found then raise exception '所選專案不屬於此客戶。'; end if;
  if p_contact_id is not null then
    select * into v_contact from public.customer_contacts where id = p_contact_id and customer_id = p_customer_id;
    if not found then raise exception '所選聯絡人不屬於此客戶。'; end if;
  end if;
  select * into v_owner from public.app_users where id = coalesce(p_owner_user_id, p_actor_user_id) and is_active = true;
  if not found then raise exception '找不到有效的負責人帳號。'; end if;

  v_sequence := public.next_business_number_value_v1('quotation:' || to_char(p_quote_date, 'YYMM'));
  if v_sequence > 9999 then raise exception '本月報價編號已達上限。'; end if;
  v_number := 'Q' || to_char(p_quote_date, 'YYMM') || lpad(v_sequence::text, 4, '0');

  insert into public.quotations(
    id, quotation_number, customer_id, project_id, owner_user_id,
    created_by_user_id, updated_by_user_id
  ) values (
    v_quotation_id, v_number, p_customer_id, p_project_id, v_owner.id,
    p_actor_user_id, p_actor_user_id
  );

  insert into public.quotation_versions(
    id, quotation_id, version_number, is_current, quote_date, valid_until, contact_id,
    customer_code_snapshot, customer_name_snapshot, customer_phone_snapshot,
    customer_email_snapshot, customer_address_snapshot, contact_name_snapshot,
    contact_title_snapshot, contact_phone_snapshot, contact_email_snapshot,
    project_code_snapshot, project_name_snapshot, note,
    created_by_user_id, updated_by_user_id
  ) values (
    v_version_id, v_quotation_id, 1, true, p_quote_date, p_valid_until, p_contact_id,
    v_customer.customer_code, v_customer.name, v_customer.phone,
    v_customer.email, v_customer.address, v_contact.name,
    v_contact.title, v_contact.phone, v_contact.email,
    v_project.project_code, v_project.name, nullif(btrim(coalesce(p_note, '')), ''),
    p_actor_user_id, p_actor_user_id
  );

  perform public.quotation_insert_items_v1(v_version_id, p_items, p_discount_twd, p_tax_rate_basis_points);
  update public.quotations
  set current_version_id = v_version_id,
      updated_by_user_id = p_actor_user_id
  where id = v_quotation_id;
  insert into public.quotation_status_history(quotation_id, quotation_version_id, from_status, to_status, note, changed_by_user_id)
  values (v_quotation_id, v_version_id, null, 'draft', '建立報價', p_actor_user_id);
  insert into public.quotation_billing_history(quotation_id, from_status, to_status, note, changed_by_user_id)
  values (v_quotation_id, null, 'unbilled', '建立報價', p_actor_user_id);

  v_result := public.quotation_detail_v1(p_actor_user_id, v_quotation_id);
  perform public.quotation_write_audit_v1(p_actor_user_id, v_quotation_id, v_version_id, 'create', null, v_result);
  return v_result;
end;
$$;

create or replace function public.update_quotation_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid,
  p_expected_quotation_row_version integer,
  p_expected_version_row_version integer,
  p_customer_id uuid,
  p_project_id uuid,
  p_owner_user_id uuid,
  p_contact_id uuid,
  p_quote_date date,
  p_valid_until date,
  p_discount_twd bigint,
  p_tax_rate_basis_points integer,
  p_note text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.quotations;
  v_version public.quotation_versions;
  v_customer public.customers;
  v_project public.projects;
  v_contact public.customer_contacts;
  v_before jsonb;
  v_after jsonb;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  select * into v_quote from public.quotations where id = p_quotation_id and archived_at is null for update;
  if not found then raise exception '找不到報價資料。'; end if;
  if v_quote.quote_status <> 'draft' then raise exception '只有草稿報價可以直接修改；請先建立新版本。'; end if;
  if v_quote.row_version is distinct from p_expected_quotation_row_version then raise exception '報價已被其他使用者更新，請重新載入。'; end if;
  select * into v_version from public.quotation_versions where id = v_quote.current_version_id and quotation_id = v_quote.id for update;
  if v_version.row_version is distinct from p_expected_version_row_version then raise exception '報價版本已被其他使用者更新，請重新載入。'; end if;
  v_before := public.quotation_detail_v1(p_actor_user_id, v_quote.id);
  if p_quote_date is null or p_valid_until is null or p_valid_until < p_quote_date then raise exception '報價日期與有效期限不正確。'; end if;
  if p_note is not null and char_length(p_note) > 4000 then raise exception '備註不可超過 4000 個字。'; end if;
  select * into v_customer from public.customers where id = p_customer_id;
  if not found then raise exception '找不到客戶資料。'; end if;
  if p_project_id is null then raise exception '報價必須選擇專案。'; end if;
  select * into v_project from public.projects where id = p_project_id and customer_id = p_customer_id;
  if not found then raise exception '所選專案不屬於此客戶。'; end if;
  if p_contact_id is not null then
    select * into v_contact from public.customer_contacts where id = p_contact_id and customer_id = p_customer_id;
    if not found then raise exception '所選聯絡人不屬於此客戶。'; end if;
  end if;
  if not exists (select 1 from public.app_users where id = p_owner_user_id and is_active = true) then raise exception '找不到有效的負責人帳號。'; end if;

  update public.quotations
  set customer_id = p_customer_id,
      project_id = p_project_id,
      owner_user_id = p_owner_user_id,
      updated_by_user_id = p_actor_user_id
  where id = v_quote.id;

  delete from public.quotation_items where quotation_version_id = v_version.id;
  update public.quotation_versions
  set quote_date = p_quote_date,
      valid_until = p_valid_until,
      contact_id = p_contact_id,
      customer_code_snapshot = v_customer.customer_code,
      customer_name_snapshot = v_customer.name,
      customer_phone_snapshot = v_customer.phone,
      customer_email_snapshot = v_customer.email,
      customer_address_snapshot = v_customer.address,
      contact_name_snapshot = v_contact.name,
      contact_title_snapshot = v_contact.title,
      contact_phone_snapshot = v_contact.phone,
      contact_email_snapshot = v_contact.email,
      project_code_snapshot = v_project.project_code,
      project_name_snapshot = v_project.name,
      subtotal_twd = 0,
      discount_twd = 0,
      tax_twd = 0,
      total_twd = 0,
      note = nullif(btrim(coalesce(p_note, '')), ''),
      updated_by_user_id = p_actor_user_id
  where id = v_version.id;
  perform public.quotation_insert_items_v1(v_version.id, p_items, p_discount_twd, p_tax_rate_basis_points);
  v_after := public.quotation_detail_v1(p_actor_user_id, v_quote.id);
  perform public.quotation_write_audit_v1(p_actor_user_id, v_quote.id, v_version.id, 'update', v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.create_quotation_version_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid,
  p_expected_quotation_row_version integer,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.quotations;
  v_old public.quotation_versions;
  v_new_id uuid := gen_random_uuid();
  v_before jsonb;
  v_after jsonb;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  select * into v_quote from public.quotations where id = p_quotation_id and archived_at is null for update;
  if not found then raise exception '找不到報價資料。'; end if;
  if v_quote.row_version is distinct from p_expected_quotation_row_version then raise exception '報價已被其他使用者更新，請重新載入。'; end if;
  if v_quote.quote_status = 'voided' then raise exception '已作廢報價不可建立新版本。'; end if;
  if v_quote.billing_status <> 'unbilled' then raise exception '已有請款進度的報價不可建立新版本。'; end if;
  v_before := public.quotation_detail_v1(p_actor_user_id, v_quote.id);
  select * into v_old from public.quotation_versions where id = v_quote.current_version_id and quotation_id = v_quote.id for update;

  update public.quotation_versions
  set is_current = false, updated_by_user_id = p_actor_user_id
  where id = v_old.id;
  insert into public.quotation_versions(
    id, quotation_id, version_number, is_current, quote_date, valid_until, contact_id,
    customer_code_snapshot, customer_name_snapshot, customer_phone_snapshot,
    customer_email_snapshot, customer_address_snapshot, contact_name_snapshot,
    contact_title_snapshot, contact_phone_snapshot, contact_email_snapshot,
    project_code_snapshot, project_name_snapshot, subtotal_twd, discount_twd,
    tax_rate_basis_points, tax_twd, total_twd, note,
    created_by_user_id, updated_by_user_id
  ) values (
    v_new_id, v_quote.id, v_old.version_number + 1, true, v_old.quote_date, v_old.valid_until, v_old.contact_id,
    v_old.customer_code_snapshot, v_old.customer_name_snapshot, v_old.customer_phone_snapshot,
    v_old.customer_email_snapshot, v_old.customer_address_snapshot, v_old.contact_name_snapshot,
    v_old.contact_title_snapshot, v_old.contact_phone_snapshot, v_old.contact_email_snapshot,
    v_old.project_code_snapshot, v_old.project_name_snapshot, v_old.subtotal_twd, v_old.discount_twd,
    v_old.tax_rate_basis_points, v_old.tax_twd, v_old.total_twd, coalesce(nullif(btrim(p_note), ''), v_old.note),
    p_actor_user_id, p_actor_user_id
  );
  insert into public.quotation_items(
    quotation_version_id, line_number, description, specification, quantity_milli,
    unit, unit_price_twd, note
  )
  select v_new_id, line_number, description, specification, quantity_milli,
    unit, unit_price_twd, note
  from public.quotation_items where quotation_version_id = v_old.id order by line_number;

  update public.quotations
  set current_version_id = v_new_id,
      quote_status = 'draft',
      quote_status_updated_at = now(),
      updated_by_user_id = p_actor_user_id
  where id = v_quote.id;
  insert into public.quotation_status_history(quotation_id, quotation_version_id, from_status, to_status, note, changed_by_user_id)
  values (v_quote.id, v_new_id, case when v_quote.quote_status = 'draft' then null else v_quote.quote_status end, 'draft', '建立新版本', p_actor_user_id);
  v_after := public.quotation_detail_v1(p_actor_user_id, v_quote.id);
  perform public.quotation_write_audit_v1(p_actor_user_id, v_quote.id, v_new_id, 'create_version', v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.update_quotation_status_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid,
  p_expected_row_version integer,
  p_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.quotations;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  select * into v_quote from public.quotations where id = p_quotation_id and archived_at is null for update;
  if not found then raise exception '找不到報價資料。'; end if;
  if v_quote.row_version is distinct from p_expected_row_version then raise exception '報價已被其他使用者更新，請重新載入。'; end if;
  if p_status is null or p_status not in ('completed','sent','confirmed','lost','won') or p_status = v_quote.quote_status then raise exception '報價狀態轉換不正確。'; end if;
  if not (
    (v_quote.quote_status = 'draft' and p_status = 'completed')
    or (v_quote.quote_status = 'completed' and p_status = 'sent')
    or (v_quote.quote_status = 'sent' and p_status in ('confirmed','lost'))
    or (v_quote.quote_status = 'confirmed' and p_status in ('won','lost'))
  ) then
    raise exception '此報價狀態不可直接轉換；需要修改內容時請建立新版本。';
  end if;
  if p_note is not null and char_length(p_note) > 1000 then raise exception '狀態備註不可超過 1000 個字。'; end if;
  update public.quotations
  set quote_status = p_status,
      quote_status_updated_at = now(),
      updated_by_user_id = p_actor_user_id
  where id = v_quote.id;
  insert into public.quotation_status_history(quotation_id, quotation_version_id, from_status, to_status, note, changed_by_user_id)
  values (v_quote.id, v_quote.current_version_id, v_quote.quote_status, p_status, nullif(btrim(coalesce(p_note, '')), ''), p_actor_user_id);
  perform public.quotation_write_audit_v1(
    p_actor_user_id, v_quote.id, v_quote.current_version_id, 'quote_status',
    jsonb_build_object('quote_status', v_quote.quote_status), jsonb_build_object('quote_status', p_status)
  );
  return public.quotation_detail_v1(p_actor_user_id, v_quote.id);
end;
$$;

create or replace function public.update_quotation_billing_status_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid,
  p_expected_row_version integer,
  p_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.quotations;
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  select * into v_quote from public.quotations where id = p_quotation_id and archived_at is null for update;
  if not found then raise exception '找不到報價資料。'; end if;
  if v_quote.row_version is distinct from p_expected_row_version then raise exception '報價已被其他使用者更新，請重新載入。'; end if;
  if v_quote.quote_status <> 'won' then raise exception '報價須先標記為已成交，才能更新請款狀態。'; end if;
  if p_status is null or p_status not in ('unbilled','preparing','in_progress','partial','completed') or p_status = v_quote.billing_status then raise exception '請款狀態轉換不正確。'; end if;
  if not (
    (v_quote.billing_status = 'unbilled' and p_status = 'preparing')
    or (v_quote.billing_status = 'preparing' and p_status in ('unbilled','in_progress'))
    or (v_quote.billing_status = 'in_progress' and p_status in ('preparing','partial','completed'))
    or (v_quote.billing_status = 'partial' and p_status in ('in_progress','completed'))
    or (v_quote.billing_status = 'completed' and p_status = 'partial')
  ) then
    raise exception '此請款狀態不可直接轉換。';
  end if;
  if (
    (v_quote.billing_status = 'preparing' and p_status = 'unbilled')
    or (v_quote.billing_status = 'in_progress' and p_status = 'preparing')
    or (v_quote.billing_status = 'partial' and p_status = 'in_progress')
    or (v_quote.billing_status = 'completed' and p_status = 'partial')
  ) and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception '請款狀態倒退時必須填寫更正原因。';
  end if;
  if p_note is not null and char_length(p_note) > 1000 then raise exception '請款備註不可超過 1000 個字。'; end if;
  update public.quotations
  set billing_status = p_status,
      billing_status_updated_at = now(),
      updated_by_user_id = p_actor_user_id
  where id = v_quote.id;
  insert into public.quotation_billing_history(quotation_id, from_status, to_status, note, changed_by_user_id)
  values (v_quote.id, v_quote.billing_status, p_status, nullif(btrim(coalesce(p_note, '')), ''), p_actor_user_id);
  perform public.quotation_write_audit_v1(
    p_actor_user_id, v_quote.id, v_quote.current_version_id, 'billing_status',
    jsonb_build_object('billing_status', v_quote.billing_status), jsonb_build_object('billing_status', p_status)
  );
  return public.quotation_detail_v1(p_actor_user_id, v_quote.id);
end;
$$;

create or replace function public.void_quotation_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid,
  p_expected_row_version integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.quotations;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  select * into v_quote from public.quotations where id = p_quotation_id and archived_at is null for update;
  if not found then raise exception '找不到報價資料。'; end if;
  if v_quote.row_version is distinct from p_expected_row_version then raise exception '報價已被其他使用者更新，請重新載入。'; end if;
  if v_quote.quote_status = 'voided' then raise exception '此報價已作廢。'; end if;
  if v_quote.billing_status <> 'unbilled' then raise exception '已有請款進度的報價不可作廢。'; end if;
  if v_reason is null or char_length(v_reason) > 1000 then raise exception '作廢原因必須為 1 至 1000 個字。'; end if;
  update public.quotations
  set quote_status = 'voided',
      quote_status_updated_at = now(),
      voided_at = now(),
      voided_by_user_id = p_actor_user_id,
      void_reason = v_reason,
      updated_by_user_id = p_actor_user_id
  where id = v_quote.id;
  insert into public.quotation_status_history(quotation_id, quotation_version_id, from_status, to_status, note, changed_by_user_id)
  values (v_quote.id, v_quote.current_version_id, v_quote.quote_status, 'voided', v_reason, p_actor_user_id);
  perform public.quotation_write_audit_v1(
    p_actor_user_id, v_quote.id, v_quote.current_version_id, 'void',
    jsonb_build_object('quote_status', v_quote.quote_status),
    jsonb_build_object('quote_status', 'voided', 'reason', v_reason)
  );
  return public.quotation_detail_v1(p_actor_user_id, v_quote.id);
end;
$$;

create or replace function public.archive_quotation_draft_v1(
  p_actor_user_id uuid,
  p_quotation_id uuid,
  p_expected_row_version integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.quotations;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.quotation_require_access_v1(p_actor_user_id);
  select * into v_quote from public.quotations where id = p_quotation_id and archived_at is null for update;
  if not found then raise exception '找不到報價資料。'; end if;
  if v_quote.row_version is distinct from p_expected_row_version then raise exception '報價已被其他使用者更新，請重新載入。'; end if;
  if v_quote.quote_status <> 'draft' or v_quote.billing_status <> 'unbilled' then raise exception '只有未請款的草稿可以封存。'; end if;
  if v_reason is null or char_length(v_reason) > 1000 then raise exception '封存原因必須為 1 至 1000 個字。'; end if;
  update public.quotations
  set archived_at = now(),
      archived_by_user_id = p_actor_user_id,
      archive_reason = v_reason,
      updated_by_user_id = p_actor_user_id
  where id = v_quote.id;
  insert into public.quotation_status_history(quotation_id, quotation_version_id, from_status, to_status, note, changed_by_user_id)
  values (v_quote.id, v_quote.current_version_id, v_quote.quote_status, 'archived', v_reason, p_actor_user_id);
  perform public.quotation_write_audit_v1(
    p_actor_user_id, v_quote.id, v_quote.current_version_id, 'archive',
    jsonb_build_object('archived_at', null),
    jsonb_build_object('archived_at', now(), 'reason', v_reason)
  );
  return jsonb_build_object('id', v_quote.id, 'archived', true);
end;
$$;

alter table public.quotation_access_users enable row level security;
alter table public.quotation_access_users force row level security;
alter table public.quotations enable row level security;
alter table public.quotations force row level security;
alter table public.quotation_versions enable row level security;
alter table public.quotation_versions force row level security;
alter table public.quotation_items enable row level security;
alter table public.quotation_items force row level security;
alter table public.quotation_status_history enable row level security;
alter table public.quotation_status_history force row level security;
alter table public.quotation_billing_history enable row level security;
alter table public.quotation_billing_history force row level security;
alter table public.quotation_audit_log enable row level security;
alter table public.quotation_audit_log force row level security;

comment on column public.quotations.billing_status is
  'MVP workflow label only; this is not an invoice, receivable, payment or accounting ledger.';

revoke all on public.quotation_access_users from public, anon, authenticated, service_role;
revoke all on public.quotations from public, anon, authenticated, service_role;
revoke all on public.quotation_versions from public, anon, authenticated, service_role;
revoke all on public.quotation_items from public, anon, authenticated, service_role;
revoke all on public.quotation_status_history from public, anon, authenticated, service_role;
revoke all on public.quotation_billing_history from public, anon, authenticated, service_role;
revoke all on public.quotation_audit_log from public, anon, authenticated, service_role;
revoke all on sequence public.quotation_status_history_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.quotation_billing_history_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.quotation_audit_log_id_seq from public, anon, authenticated, service_role;

grant select on public.quotation_access_users to service_role;

revoke all on function public.quotation_require_access_v1(uuid) from public, anon, authenticated;
revoke all on function public.quotation_assert_current_version_v1() from public, anon, authenticated, service_role;
revoke all on function public.quotation_insert_items_v1(uuid,jsonb,bigint,integer) from public, anon, authenticated, service_role;
revoke all on function public.quotation_write_audit_v1(uuid,uuid,uuid,text,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.quotation_detail_v1(uuid,uuid) from public, anon, authenticated;
revoke all on function public.quotation_version_detail_v1(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.quotation_options_v1(uuid) from public, anon, authenticated;
revoke all on function public.quotation_dashboard_v1(uuid) from public, anon, authenticated;
revoke all on function public.quotation_project_tracking_v1(uuid,text,text,text,uuid) from public, anon, authenticated;
revoke all on function public.quotation_list_v1(uuid,text,text,text,uuid,uuid,timestamptz,uuid,integer) from public, anon, authenticated;
revoke all on function public.create_quotation_v1(uuid,uuid,uuid,uuid,uuid,date,date,bigint,integer,text,jsonb) from public, anon, authenticated;
revoke all on function public.update_quotation_v1(uuid,uuid,integer,integer,uuid,uuid,uuid,uuid,date,date,bigint,integer,text,jsonb) from public, anon, authenticated;
revoke all on function public.create_quotation_version_v1(uuid,uuid,integer,text) from public, anon, authenticated;
revoke all on function public.update_quotation_status_v1(uuid,uuid,integer,text,text) from public, anon, authenticated;
revoke all on function public.update_quotation_billing_status_v1(uuid,uuid,integer,text,text) from public, anon, authenticated;
revoke all on function public.void_quotation_v1(uuid,uuid,integer,text) from public, anon, authenticated;
revoke all on function public.archive_quotation_draft_v1(uuid,uuid,integer,text) from public, anon, authenticated;

grant execute on function public.quotation_require_access_v1(uuid) to service_role;
grant execute on function public.quotation_detail_v1(uuid,uuid) to service_role;
grant execute on function public.quotation_version_detail_v1(uuid,uuid,uuid) to service_role;
grant execute on function public.quotation_options_v1(uuid) to service_role;
grant execute on function public.quotation_dashboard_v1(uuid) to service_role;
grant execute on function public.quotation_project_tracking_v1(uuid,text,text,text,uuid) to service_role;
grant execute on function public.quotation_list_v1(uuid,text,text,text,uuid,uuid,timestamptz,uuid,integer) to service_role;
grant execute on function public.create_quotation_v1(uuid,uuid,uuid,uuid,uuid,date,date,bigint,integer,text,jsonb) to service_role;
grant execute on function public.update_quotation_v1(uuid,uuid,integer,integer,uuid,uuid,uuid,uuid,date,date,bigint,integer,text,jsonb) to service_role;
grant execute on function public.create_quotation_version_v1(uuid,uuid,integer,text) to service_role;
grant execute on function public.update_quotation_status_v1(uuid,uuid,integer,text,text) to service_role;
grant execute on function public.update_quotation_billing_status_v1(uuid,uuid,integer,text,text) to service_role;
grant execute on function public.void_quotation_v1(uuid,uuid,integer,text) to service_role;
grant execute on function public.archive_quotation_draft_v1(uuid,uuid,integer,text) to service_role;
