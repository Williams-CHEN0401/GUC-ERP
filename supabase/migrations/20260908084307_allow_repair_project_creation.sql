begin;

-- The public project form and v2 wrapper already accept repair; keep the
-- underlying number allocator in sync without changing numbering or ACLs.
CREATE OR REPLACE FUNCTION public.create_project_auto_number_v1(p_name text, p_customer_id uuid, p_project_type text, p_status text, p_assigned_to text, p_description text, p_estimated_cost numeric, p_note text, p_actor text)
 RETURNS projects
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_result public.projects; v_number bigint; v_prefix text := to_char(current_date,'YYMM');
begin
  if nullif(btrim(p_name),'') is null or p_customer_id is null then raise exception '請完整填寫專案資料。'; end if;
  if p_project_type not in ('construction','repair','maintenance') then raise exception '專案類型不正確。'; end if;
  if not exists(select 1 from public.customers where id=p_customer_id) then raise exception '找不到指定客戶。'; end if;
  v_number := public.next_business_number_value_v1('project:'||v_prefix);
  if v_number > 999 then raise exception '本月案件編號已達上限，請聯絡管理者。'; end if;
  insert into public.projects(project_code,name,customer_id,project_type,status,assigned_to,description,estimated_cost,note,source,updated_by)
  values (v_prefix||lpad(v_number::text,3,'0'),btrim(p_name),p_customer_id,p_project_type,btrim(p_status),nullif(btrim(p_assigned_to),''),nullif(btrim(p_description),''),p_estimated_cost,nullif(btrim(p_note),''),'web',p_actor)
  returning * into v_result;
  return v_result;
end; $function$
;;

commit;
