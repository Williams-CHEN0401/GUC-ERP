-- Customer-entered feedback is a response record, not a new customer master.
SET lock_timeout='5s';
SET statement_timeout='60s';
CREATE TABLE public.customer_feedback_responses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE,
 payload_hash text NOT NULL CHECK(length(payload_hash)=64),
 customer_name text NOT NULL CHECK(length(btrim(customer_name)) BETWEEN 1 AND 160),
 contract_content text NOT NULL CHECK(length(btrim(contract_content)) BETWEEN 1 AND 1500),
 respondent_name text NOT NULL DEFAULT '' CHECK(length(respondent_name)<=80),
 service_attitude smallint NOT NULL CHECK(service_attitude BETWEEN 1 AND 5),
 construction_quality smallint NOT NULL CHECK(construction_quality BETWEEN 1 AND 5),
 handling_speed smallint NOT NULL CHECK(handling_speed BETWEEN 1 AND 5),
 engineer_expertise smallint NOT NULL CHECK(engineer_expertise BETWEEN 1 AND 5),
 comments text NOT NULL DEFAULT '' CHECK(length(comments)<=2000),
 request_followup boolean NOT NULL DEFAULT false,
 contact text NOT NULL DEFAULT '' CHECK(length(contact)<=200),
 submitted_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT request_followup OR length(btrim(contact))>=3)
);
CREATE INDEX customer_feedback_submitted_idx ON public.customer_feedback_responses(submitted_at DESC,id);
ALTER TABLE public.customer_feedback_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_feedback_responses FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.customer_feedback_responses TO service_role;

CREATE FUNCTION public.customer_feedback_submit_v1(p_request_id uuid,p_answers jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $f$
DECLARE a jsonb; r public.customer_feedback_responses; h text; k text;
BEGIN
 IF p_request_id IS NULL OR jsonb_typeof(p_answers) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '表單格式不正確。' USING ERRCODE='22023'; END IF;
 FOREACH k IN ARRAY ARRAY['customer_name','contract_content','respondent_name','comments','contact'] LOOP
  IF jsonb_typeof(p_answers->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION '表單文字格式不正確。' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF jsonb_typeof(p_answers->'request_followup') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION '聯繫選項格式不正確。' USING ERRCODE='22023'; END IF;
 FOREACH k IN ARRAY ARRAY['service_attitude','construction_quality','handling_speed','engineer_expertise'] LOOP
  IF jsonb_typeof(p_answers->k) IS DISTINCT FROM 'number' OR (p_answers->>k)!~'^[1-5]$' THEN RAISE EXCEPTION '請完成四項五級評分。' USING ERRCODE='22023'; END IF;
 END LOOP;
 a:=jsonb_build_object('customer_name',btrim(p_answers->>'customer_name'),'contract_content',btrim(p_answers->>'contract_content'),
 'respondent_name',btrim(p_answers->>'respondent_name'),'comments',btrim(p_answers->>'comments'),
 'contact',CASE WHEN (p_answers->>'request_followup')::boolean THEN btrim(p_answers->>'contact') ELSE '' END,
 'request_followup',(p_answers->>'request_followup')::boolean,'service_attitude',(p_answers->>'service_attitude')::int,
 'construction_quality',(p_answers->>'construction_quality')::int,'handling_speed',(p_answers->>'handling_speed')::int,'engineer_expertise',(p_answers->>'engineer_expertise')::int);
 h:=encode(sha256(convert_to(a::text,'UTF8')),'hex');
 INSERT INTO public.customer_feedback_responses(request_id,payload_hash,customer_name,contract_content,respondent_name,service_attitude,construction_quality,handling_speed,engineer_expertise,comments,request_followup,contact)
 VALUES(p_request_id,h,a->>'customer_name',a->>'contract_content',a->>'respondent_name',(a->>'service_attitude')::int,(a->>'construction_quality')::int,(a->>'handling_speed')::int,(a->>'engineer_expertise')::int,a->>'comments',(a->>'request_followup')::boolean,a->>'contact')
 ON CONFLICT(request_id) DO NOTHING RETURNING * INTO r;
 IF r.id IS NULL THEN
  SELECT * INTO r FROM public.customer_feedback_responses WHERE request_id=p_request_id;
  IF r.payload_hash IS DISTINCT FROM h THEN RAISE EXCEPTION '這份表單已送出，請重新開始填寫。' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN jsonb_build_object('reference','GUC-FB-'||to_char(r.submitted_at AT TIME ZONE 'Asia/Taipei','YYYYMMDD')||'-'||upper(left(replace(r.id::text,'-',''),8)),'submitted_at',r.submitted_at);
END $f$;
REVOKE ALL ON FUNCTION public.customer_feedback_submit_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.customer_feedback_submit_v1(uuid,jsonb) TO service_role;

CREATE FUNCTION public.customer_feedback_admin_v1(p_actor_user_id uuid,p_query text DEFAULT '',p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_page integer DEFAULT 1,p_page_size integer DEFAULT 50,p_export boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $f$
DECLARE result jsonb;
BEGIN
 IF NOT coalesce(public.has_app_permission_v1(p_actor_user_id,'settings','VIEW'),false) THEN RAISE EXCEPTION '沒有客戶意見管理權限，需具有管理設定查看權限。' USING ERRCODE='42501'; END IF;
 IF p_export AND NOT coalesce(public.has_app_permission_v1(p_actor_user_id,'data_export','VIEW'),false) THEN RAISE EXCEPTION '沒有匯出權限。' USING ERRCODE='42501'; END IF;
 IF length(coalesce(p_query,''))>160 OR p_page<1 OR p_page>100000 OR p_page_size NOT BETWEEN 1 AND 200 OR p_from>p_to THEN RAISE EXCEPTION '搜尋或日期範圍不正確。' USING ERRCODE='22023'; END IF;
 WITH filtered AS MATERIALIZED (
 SELECT * FROM public.customer_feedback_responses
 WHERE (coalesce(p_query,'')='' OR strpos(lower(customer_name||' '||contract_content||' '||respondent_name),lower(p_query))>0)
 AND (p_from IS NULL OR submitted_at >= (p_from::timestamp AT TIME ZONE 'Asia/Taipei'))
 AND (p_to IS NULL OR submitted_at < ((p_to+1)::timestamp AT TIME ZONE 'Asia/Taipei'))
 ), page_rows AS (SELECT * FROM filtered ORDER BY submitted_at DESC,id OFFSET (p_page-1)*p_page_size LIMIT p_page_size)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'page',p_page,'page_size',p_page_size,
 'can_export',coalesce(public.has_app_permission_v1(p_actor_user_id,'data_export','VIEW'),false),
 'stats',(SELECT jsonb_build_object('count',count(*),'average',round(avg((service_attitude+construction_quality+handling_speed+engineer_expertise)/4.0),2),
 'service_attitude',round(avg(service_attitude),2),'construction_quality',round(avg(construction_quality),2),'handling_speed',round(avg(handling_speed),2),'engineer_expertise',round(avg(engineer_expertise),2),
 'low_score_count',count(*) FILTER(WHERE least(service_attitude,construction_quality,handling_speed,engineer_expertise)<=2),'followup_count',count(*) FILTER(WHERE request_followup)) FROM filtered),
 'records',coalesce((SELECT jsonb_agg((to_jsonb(r)-'request_id'-'payload_hash')||jsonb_build_object('average_score',round((service_attitude+construction_quality+handling_speed+engineer_expertise)/4.0,2),
 'reference','GUC-FB-'||to_char(submitted_at AT TIME ZONE 'Asia/Taipei','YYYYMMDD')||'-'||upper(left(replace(id::text,'-',''),8))) ORDER BY submitted_at DESC,id) FROM page_rows r),'[]')) INTO result;
 RETURN result;
END $f$;
REVOKE ALL ON FUNCTION public.customer_feedback_admin_v1(uuid,text,date,date,integer,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.customer_feedback_admin_v1(uuid,text,date,date,integer,integer,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
