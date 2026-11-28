export const SCORE_FIELDS = Object.freeze([
  {key:'service_attitude',label:'服務態度',hint:'溝通是否友善、主動，並尊重您的需求。'},
  {key:'construction_quality',label:'施工品質',hint:'施工成果、現場整潔與使用表現是否符合期待。'},
  {key:'handling_speed',label:'案件處理速度',hint:'回應、安排與問題處理是否即時。'},
  {key:'engineer_expertise',label:'工程師專業度',hint:'技術能力、問題判斷與說明是否清楚可靠。'}
]);
export const RATINGS = Object.freeze([{value:5,label:'滿意'},{value:4,label:'尚滿意'},{value:3,label:'普通'},{value:2,label:'不滿意'},{value:1,label:'非常不滿意'}]);
export function normalizeSubmission(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('表單格式不正確，請重新填寫。');
  const field=(name,label,max,required=false)=>{
    if(input[name]!==undefined&&typeof input[name]!=='string')throw Error(`${label}格式不正確。`);
    const value=(input[name]||'').trim();
    if(required&&!value)throw Error(`請填寫${label}。`);
    if(value.length>max)throw Error(`${label}不可超過 ${max} 個字。`);
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error(`${label}包含不支援的字元。`);
    return value;
  };
  if(typeof input.request_followup!=='boolean')throw Error('請確認是否需要聯繫。');
  const result={customer_name:field('customer_name','客戶名稱',160,true),contract_content:field('contract_content','承攬內容',1500,true),respondent_name:field('respondent_name','填寫人姓名',80),comments:field('comments','改善建議',2000),request_followup:input.request_followup,contact:input.request_followup?field('contact','聯絡方式',200,true):''};
  for(const {key,label}of SCORE_FIELDS){if(!Number.isInteger(input[key])||input[key]<1||input[key]>5)throw Error(`請完成「${label}」評分。`);result[key]=input[key];}
  if(result.request_followup&&result.contact.length<3)throw Error('請填寫可供聯繫的電話或電子郵件。');
  return result;
}
export function csvCell(value) {
  let text=String(value??'');
  if(/^[\s\uFEFF]*[=+@\-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
