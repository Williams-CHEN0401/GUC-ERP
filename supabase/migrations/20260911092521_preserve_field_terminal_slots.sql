begin;

-- A physical field slot can exist before its system-side extension is identified.
-- Keep the existing master data, composite customer FK, location uniqueness and RLS.
alter table public.phone_terminal_points alter column phone_extension_id drop not null;
alter table public.phone_terminal_points
  add column building_name text check (building_name is null or char_length(building_name) <= 80),
  add column source_extension_number text check (source_extension_number is null or char_length(source_extension_number) <= 40),
  add column source_phone_type text check (source_phone_type is null or char_length(source_phone_type) <= 200),
  add column resolved_phone_type text check (resolved_phone_type in ('digital','analog','ip','trunk','unknown')),
  add column field_match_status text check (field_match_status in ('matched','empty','unmatched','conflict')),
  add column field_match_message text check (field_match_message is null or char_length(field_match_message) <= 500),
  add constraint phone_terminal_points_unlinked_field_check check (phone_extension_id is not null or endpoint_side = 'field');

create index phone_terminal_points_field_number_idx
  on public.phone_terminal_points(customer_id, contract_service_type_id, source_extension_number)
  where endpoint_side = 'field' and source_extension_number is not null;

create function public.phone_import_system_type_v1(p_extension public.phone_extensions, p_frame text)
returns text language sql immutable security invoker set search_path = '' as $$
  select case
    when regexp_replace(coalesce(p_frame,''),'[[:space:]　]+','','g') like '數位分機系統端%' then 'digital'
    when regexp_replace(coalesce(p_frame,''),'[[:space:]　]+','','g') like '類比分機系統端%' then 'analog'
    when p_extension.line_type = 'trunk' then 'trunk'
    else coalesce(lower((regexp_match(coalesce(p_extension.notes,''),'(?:^|\n)\[\[(?:GUC_PHONE_TYPE|phone_type):(digital|analog|ip|trunk)\]\]','i'))[1]),
      case when coalesce(p_extension.device_model,'') ~* '\mIP\M' then 'ip'
        when coalesce(p_extension.device_model,'') ~* '數位|digital' then 'digital' else 'unknown' end)
  end;
$$;
revoke all on function public.phone_import_system_type_v1(public.phone_extensions,text) from public,anon,authenticated;
grant execute on function public.phone_import_system_type_v1(public.phone_extensions,text) to service_role;

create function public.import_phone_field_rows_v1(
  p_customer_id uuid, p_contract_service_type_id uuid, p_file_name text,
  p_rows jsonb, p_actor text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r jsonb; v_point public.phone_terminal_points; v_extension public.phone_extensions;
  v_frame text; v_board text; v_slot integer; v_number text; v_building text; v_floor text;
  v_type_source text; v_match_key text; v_type text; v_system_type text; v_types text[];
  v_status text; v_message text; v_type_status text; v_type_message text;
  v_link uuid; v_system_count integer; v_duplicate boolean; v_systems jsonb; v_saved jsonb;
  v_inserted integer := 0; v_updated integer := 0; v_failed integer := 0; v_flagged integer := 0; v_empty integer := 0;
  v_type_matched integer := 0; v_type_unmatched integer := 0; v_type_conflict integer := 0; v_type_empty integer := 0;
  v_failures jsonb := '[]'; v_sources jsonb := '[]'; v_results jsonb := '[]'; v_log_id uuid;
begin
  if p_customer_id is null or p_contract_service_type_id is null
    or nullif(btrim(p_file_name),'') is null or char_length(p_file_name)>255
    or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 1000
    or nullif(btrim(p_actor),'') is null or char_length(p_actor)>160 then
    raise exception '端子匯入資料不完整。';
  end if;
  perform 1 from public.customer_contract_services c join public.contract_service_types s on s.id=c.service_type_id
    where c.customer_id=p_customer_id and c.service_type_id=p_contract_service_type_id and s.code='phone_system' and s.is_active for update of c;
  if not found then raise exception '指定客戶沒有有效的電話系統承攬內容。'; end if;
  perform set_config('app.actor',p_actor,true);
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'number',btrim(e.extension_number),'type',public.phone_import_system_type_v1(e,p.frame_name),
    'source',lower(btrim(regexp_replace(coalesce((regexp_match(coalesce(p.notes,''),'(?:^|\n)[[:space:]]*Excel[[:space:]]*型態[[:space:]]*[:：][[:space:]]*([^\r\n]*)','i'))[1],''),'[[:space:]　]+',' ','g'))))), '[]')
    into v_systems from public.phone_terminal_points p join public.phone_extensions e on e.id=p.phone_extension_id
    where p.customer_id=p_customer_id and p.contract_service_type_id=p_contract_service_type_id and p.endpoint_side='system';

  for r in select value from jsonb_array_elements(p_rows) loop
    begin
      v_frame:=nullif(btrim(r->>'frame_name'),''); v_board:=nullif(btrim(r->>'board'),'');
      v_slot:=case when coalesce(r->>'slot','') ~ '^[0-9]{1,5}$' then (r->>'slot')::integer end;
      v_number:=nullif(btrim(r->>'extension_number'),''); v_building:=nullif(btrim(r->>'building'),''); v_floor:=nullif(btrim(r->>'floor'),'');
      v_type_source:=nullif(btrim(r->>'terminal_type'),'');
      if v_frame is null or char_length(v_frame)>160 or v_board is null or char_length(v_board)>80
        or v_slot is null or v_slot not between 1 and 10000 or v_building is null or char_length(v_building)>80 or v_floor is null or char_length(v_floor)>80
        or char_length(coalesce(v_number,''))>40 or char_length(coalesce(v_type_source,''))>200
        or char_length(coalesce(r->>'terminal_position',''))>80 or char_length(coalesce(r->>'installation_location',''))>300 then
        raise exception '現場端缺少可辨識的棟名、樓層、端子板或有效槽位。';
      end if;
      if (select count(*) from jsonb_array_elements(p_rows) x where btrim(x->>'frame_name')=v_frame and btrim(x->>'board')=v_board
        and case when coalesce(x->>'slot','') ~ '^[0-9]{1,5}$' then (x->>'slot')::integer end=v_slot)>1 then
        raise exception '檔案內出現重複的端子群組＋端子板＋槽位，請先確認位置。';
      end if;
      v_point:=null; v_extension:=null; v_link:=null;
      select * into v_point from public.phone_terminal_points where customer_id=p_customer_id and contract_service_type_id=p_contract_service_type_id
        and endpoint_side='field' and frame_name=v_frame and frame_block=v_board and frame_position=v_slot for update;
      select count(*),min(x->>'type') into v_system_count,v_system_type from jsonb_array_elements(v_systems) x where x->>'number'=v_number;
      if v_system_count=1 then
        select e.* into v_extension from public.phone_extensions e where e.customer_id=p_customer_id and e.contract_service_type_id=p_contract_service_type_id and btrim(e.extension_number)=v_number;
        v_link:=v_extension.id;
      end if;
      v_duplicate:=v_number is not null and (
        (select count(*) from jsonb_array_elements(p_rows) x where btrim(x->>'extension_number')=v_number)>1
        or exists(select 1 from public.phone_terminal_points p left join public.phone_extensions e on e.id=p.phone_extension_id
          where p.customer_id=p_customer_id and p.contract_service_type_id=p_contract_service_type_id and p.endpoint_side='field'
            and p.id is distinct from v_point.id and btrim(coalesce(e.extension_number,p.source_extension_number))=v_number));

      v_type:='unknown'; v_type_status:='unmatched'; v_type_message:='找不到系統端精確對應；電話類型保持空白';
      v_match_key:=lower(btrim(regexp_replace(coalesce(v_type_source,''),'[[:space:]　]+',' ','g')));
      if v_match_key='' then
        if v_system_count=1 and v_system_type<>'unknown' then
          v_type:=v_system_type; v_type_status:='matched'; v_type_message:='Excel 話機類型空白；已依同號碼系統端補入';
        elsif v_number is null then v_type_status:='empty'; v_type_message:='空白槽位；保留空白話機類型';
        else v_type_message:='Excel 話機類型空白；系統端沒有可唯一確認的話機類型'; end if;
      else
        select array_agg(distinct x->>'type') into v_types from jsonb_array_elements(v_systems) x where x->>'type'<>'unknown' and (
          x->>'source'=v_match_key or
          (x->>'type'='digital' and v_match_key in ('數位','數位話機','digital')) or
          (x->>'type'='analog' and v_match_key in ('類比','類比話機','analog')) or
          (x->>'type'='ip' and v_match_key in ('ip','ip 話機')) or
          (x->>'type'='trunk' and v_match_key in ('外線','中繼','外線／中繼','trunk')));
        if cardinality(v_types)=1 then
          v_type:=v_types[1]; v_type_status:='matched'; v_type_message:='話機類型已精確匹配系統端資料';
          if v_system_count=1 and v_system_type<>'unknown' and v_type<>v_system_type then
            v_type:='unknown'; v_type_status:='conflict'; v_type_message:='Excel 話機類型與同號碼系統端不一致';
          end if;
        elsif cardinality(v_types)>1 then v_type_status:='conflict'; v_type_message:='話機類型在系統端對應到不同電話類型'; end if;
      end if;
      v_status:='matched'; v_message:='已匹配唯一系統端';
      if v_number is null then v_status:='empty'; v_message:='空白槽位，完整保留';
      elsif v_duplicate then v_status:='conflict'; v_message:='號碼在檔案或其他現場端位置重複；保留資料並標紅'; v_link:=null;
      elsif v_system_count<>1 then v_status:=case when v_system_count>1 then 'conflict' else 'unmatched' end; v_message:='找不到唯一系統端關聯；保留原始號碼並標紅';
      elsif v_type_status in ('unmatched','conflict') then v_status:=v_type_status; v_message:='話機類型尚未確認；保留資料並標紅'; end if;

      if v_point.id is null then
        insert into public.phone_terminal_points(customer_id,contract_service_type_id,phone_extension_id,endpoint_side,frame_name,frame_block,frame_position,
          slot_identifier,terminal_code,building_name,floor,installation_location,source_extension_number,source_phone_type,resolved_phone_type,
          field_match_status,field_match_message,source_reference,notes,source,updated_by)
        values(p_customer_id,p_contract_service_type_id,v_link,'field',v_frame,v_board,v_slot,v_slot::text,nullif(btrim(r->>'terminal_position'),''),v_building,v_floor,
          nullif(btrim(r->>'installation_location'),''),v_number,v_type_source,v_type,v_status,v_message,
          concat(p_file_name,':',r->>'source_sheet',':R',r->>'source_row','C',r->>'source_column'),
          case when v_type_source is not null then 'Excel 型態：'||v_type_source end,'excel_import',p_actor) returning * into v_point;
        v_inserted:=v_inserted+1;
      else
        update public.phone_terminal_points set phone_extension_id=v_link,slot_identifier=v_slot::text,
          terminal_code=nullif(btrim(r->>'terminal_position'),''),building_name=v_building,floor=v_floor,
          installation_location=nullif(btrim(r->>'installation_location'),''),source_extension_number=v_number,source_phone_type=v_type_source,
          resolved_phone_type=v_type,field_match_status=v_status,field_match_message=v_message,
          source_reference=concat(p_file_name,':',r->>'source_sheet',':R',r->>'source_row','C',r->>'source_column'),
          notes=case when v_type_source is not null then 'Excel 型態：'||v_type_source end,source='excel_import',updated_by=p_actor
        where id=v_point.id returning * into v_point;
        v_updated:=v_updated+1;
      end if;
      if v_status in ('unmatched','conflict') then v_flagged:=v_flagged+1; end if;
      if v_status='empty' then v_empty:=v_empty+1; end if;
      if v_type_status='matched' then v_type_matched:=v_type_matched+1;
      elsif v_type_status='unmatched' then v_type_unmatched:=v_type_unmatched+1;
      elsif v_type_status='conflict' then v_type_conflict:=v_type_conflict+1;
      else v_type_empty:=v_type_empty+1; end if;
      v_saved:=jsonb_build_object('terminal_id',v_point.id,'slot',v_slot,'field_match_status',v_status,'field_match_message',v_message,
        'phone_type',v_type,'phone_type_match_status',v_type_status,'phone_type_match_message',v_type_message);
      v_results:=v_results||jsonb_build_array(v_saved);
      v_sources:=v_sources||jsonb_build_array(r||v_saved);
    exception when others then
      v_failed:=v_failed+1;
      v_failures:=v_failures||jsonb_build_array(jsonb_build_object('source_sheet',r->>'source_sheet','source_row',r->>'source_row','source_column',r->>'source_column','message',left(sqlerrm,500)));
      v_sources:=v_sources||jsonb_build_array(r||jsonb_build_object('import_error',left(sqlerrm,500)));
    end;
  end loop;
  insert into public.phone_terminal_import_logs(customer_id,contract_service_type_id,file_name,import_type,actor,total_count,inserted_count,updated_count,skipped_count,failed_count,failure_reasons,source_rows)
    values(p_customer_id,p_contract_service_type_id,p_file_name,'field',p_actor,jsonb_array_length(p_rows),v_inserted,v_updated,0,v_failed,v_failures,v_sources) returning id into v_log_id;
  return jsonb_build_object('log_id',v_log_id,'total',jsonb_array_length(p_rows),'inserted',v_inserted,'updated',v_updated,'skipped',0,'failed',v_failed,
    'flagged',v_flagged,'empty_slots',v_empty,'phone_type_matched',v_type_matched,'phone_type_unmatched',v_type_unmatched,'phone_type_conflict',v_type_conflict,'phone_type_empty',v_type_empty,'failure_reasons',v_failures,'rows',v_results);
end;
$$;
revoke all on function public.import_phone_field_rows_v1(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.import_phone_field_rows_v1(uuid,uuid,text,jsonb,text) to service_role;

commit;
