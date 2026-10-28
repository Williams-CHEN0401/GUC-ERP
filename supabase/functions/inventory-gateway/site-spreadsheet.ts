// Shared server validation for optional spreadsheet values. Business duplicates
// are intentional; identifiers and authorization are supplied by the gateway.
type Row = Record<string, unknown>;
const deviceText: Record<string, number> = { device_no:120,device_name:160,device_brand:120,device_model:160,network_cable_no:120,cabinet:160,details:4000,notes:4000,access_station_no:80,serial_number:160 };
const historyText: Record<string, number> = { description:4000,cause:2000,handling_process:2000,result:2000,notes:2000,worker_names_text:2000 };
const normalizeHeader=(value:string)=>value.trim().normalize('NFKC').toLocaleLowerCase('zh-Hant').replace(/[\s_\-/／（）()]/g,'');
const sensitiveName=(value:string)=>['帳號','登入帳號','使用者帳號','登入密碼','username','loginusername','loginpassword','password'].includes(normalizeHeader(value))||/password|passwd|密碼|帳密|secret|token|api.?key/i.test(value);
function customName(value:string):boolean {
  return !!value.trim()&&value.length<=120&&!/[\u0000-\u001f]/.test(value)&&!['__proto__','constructor','prototype'].includes(value.toLowerCase())
    &&!sensitiveName(value);
}
export function spreadsheetFields(value:unknown):Row {
  if(value==null)return {};
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>50||JSON.stringify(value).length>262144)throw Error('Excel 自訂欄位格式或大小不正確。');
  const fields:Row={};
  for(const [key,cell] of Object.entries(value)){
    if(!customName(key))throw Error('Excel 自訂欄位不得包含帳密或保留名稱。');
    fields[key]=spreadsheetText(cell,4000,true);
  }
  return fields;
}
export function spreadsheetColumns(kind:'devices'|'history',value:unknown):{key:string;label:string}[] {
  if(!Array.isArray(value)||value.length<1||value.length>50)throw Error('範本須有 1 至 50 個欄位。');
  const known=new Set(kind==='history'?[...Object.keys(historyText).filter(k=>k!=='handling_process'),'occurred_at','event_type']:[...Object.keys(deviceText),'device_type','ip_address','http_port','manual_url','status','supports_audio','resolution_width','resolution_height','fps','installed_on','warranty_end_on','login_username','login_password']);
  const used=new Set<string>();
  return value.map(column=>{
    if(!column||typeof column!=='object'||Array.isArray(column))throw Error('範本欄位格式不正確。');
    const key=spreadsheetText(column.key,127),label=spreadsheetText(column.label,120);
    if(!key||!label||used.has(key)||/[\u0000-\u001f]/.test(key+label)||sensitiveName(label)&&!['login_username','login_password'].includes(key)||!known.has(key)&&!(key.startsWith('custom:')&&customName(key.slice(7))&&customName(label)))throw Error('範本欄位對應不正確、重複，或包含帳密保留名稱。');
    used.add(key);return {key,label};
  });
}
export function spreadsheetText(value: unknown, max: number, preserve = false): string {
  if(value == null)return '';
  if(typeof value !== 'string')throw Error('Excel 文字欄位格式不正確。');
  const result=preserve?value:value.trim();
  if(result.length>max||/[\u0000]/.test(result))throw Error('Excel 文字欄位超出長度或包含不支援字元。');
  return result;
}
function optionalDate(value: unknown): string | null {
  const result=spreadsheetText(value,10);if(!result)return null;
  const parsed=new Date(`${result}T00:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(result)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==result)throw Error('Excel 日期格式不正確。');
  return result;
}
export function siteSpreadsheetRow(candidate: unknown, kind: 'devices'|'history'): Row {
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw Error('Excel 匯入列格式不正確。');
  const row=candidate as Row, sourceRow=Number(row.source_row), result:Row={};
  if(!Number.isInteger(sourceRow)||sourceRow<2||sourceRow>1048576)throw Error('Excel 來源列號不正確。');
  result.source_row=sourceRow;
  result.spreadsheet_fields=spreadsheetFields(row.spreadsheet_fields);
  for(const [key,max] of Object.entries(kind==='history'?historyText:deviceText))result[key]=spreadsheetText(row[key],max)||null;
  if(kind==='history'){
    result.occurred_at=optionalDate(row.occurred_at);
    const type=spreadsheetText(row.event_type,40);
    if(type&&!['SOFTWARE_CONFIG','LINE_REPAIR','LINE_REPLACEMENT','REPAIR','REPLACEMENT','EQUIPMENT_TEST','INSTALLATION','MAINTENANCE','PROGRAM_CONFIG','INSPECTION','OTHER'].includes(type))throw Error('事件類型格式不正確。');
    result.event_type=type||null;
    return result;
  }
  const type=spreadsheetText(row.device_type,40),status=spreadsheetText(row.status,40);
  if(type&&!['monitoring_host','camera','hub'].includes(type))throw Error('設備種類格式不正確。');
  if(status&&!['planned','installed','tested','active','inactive','maintenance'].includes(status))throw Error('設備狀態格式不正確。');
  result.device_type=type||null;result.status=status||null;
  // PostgreSQL inet provides the authoritative canonical IP validation.
  result.ip_address=spreadsheetText(row.ip_address,64)||null;
  for(const [key,max] of Object.entries({http_port:65535,resolution_width:16384,resolution_height:16384,fps:240})){
    const value=row[key];
    if(value==null||value===''){result[key]=null;continue;}
    if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!/^\d+$/.test(value))throw Error(`Excel 數值欄位 ${key} 格式不正確。`);
    const number=Number(value);if(!Number.isInteger(number)||number<1||number>max)throw Error(`Excel 數值欄位 ${key} 超出範圍。`);
    result[key]=number;
  }
  if(row.supports_audio!=null&&row.supports_audio!==''&&typeof row.supports_audio!=='boolean')throw Error('音訊欄位格式不正確。');
  result.supports_audio=typeof row.supports_audio==='boolean'?row.supports_audio:null;
  result.installed_on=optionalDate(row.installed_on);result.warranty_end_on=optionalDate(row.warranty_end_on);
  const manual=spreadsheetText(row.manual_url,1000);
  if(manual){let parsed:URL;try{parsed=new URL(manual);}catch{throw Error('說明網址格式不正確。');}if(!['http:','https:'].includes(parsed.protocol))throw Error('說明網址格式不正確。');}
  result.manual_url=manual||null;
  return result;
}
