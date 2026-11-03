-- Work-content forms may omit a department, including customers with rooms.
-- Retain the common validator for every supplied department and leave other
-- document types' required/legacy rules unchanged.
begin;
set local lock_timeout='5s';
do $patch$
declare definition text; original text; replacement text;
begin
 definition:=replace(pg_get_functiondef('public.upsert_erp_project_department_v1(uuid,integer,text,uuid,text,text,text,numeric,text,uuid[],text,date,text,uuid,boolean)'::regprocedure),chr(13),'');
 original:=$old$  perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_old.department_id,
    p_id is not null and v_old.customer_id=p_customer_id);$old$;
 replacement:=$new$  if p_department_id is not null then
    perform public.assert_customer_department_v1(p_customer_id,p_department_id,v_old.department_id,
      p_id is not null and v_old.customer_id=p_customer_id);
  end if;$new$;
 if position(original in definition)=0 then raise exception 'Unexpected project department validation baseline';end if;
 execute replace(definition,original,replacement);
end $patch$;
-- Existing numbering, customer validation, permissions, private-data scope,
-- optimistic versions, inactive-room preservation and audit stay in force.
notify pgrst,'reload schema';
commit;
