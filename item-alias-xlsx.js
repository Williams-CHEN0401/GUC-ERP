/* Bounded, local-only XLSX reader. Reuses the shared workbook exporter. */
(()=>{
 const decode=new TextDecoder(),MAX=20*1024*1024;
 async function files(buffer){
  const bytes=new Uint8Array(buffer),v=new DataView(buffer),out=new Map();let end=-1,total=0;
  if(bytes.length<22||bytes.length>5*1024*1024)throw Error('Excel 檔案須為 5 MB 以下的 .xlsx。');
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(v.getUint32(p,true)===0x06054b50){end=p;break;}
  if(end<0)throw Error('無法讀取 Excel 活頁簿，請使用 .xlsx 格式。');
  if(v.getUint16(end+4,true)||v.getUint16(end+6,true))throw Error('不支援分割壓縮活頁簿。');
  const count=v.getUint16(end+10,true);let offset=v.getUint32(end+16,true);
  if(count>300)throw Error('Excel 內含過多檔案，請另存精簡範本。');
  for(let index=0;index<count;index++){
   if(offset+46>bytes.length||v.getUint32(offset,true)!==0x02014b50)throw Error('Excel 壓縮目錄損毀。');
   const flags=v.getUint16(offset+8,true),method=v.getUint16(offset+10,true),size=v.getUint32(offset+20,true),expanded=v.getUint32(offset+24,true),length=v.getUint16(offset+28,true),extra=v.getUint16(offset+30,true),comment=v.getUint16(offset+32,true),local=v.getUint32(offset+42,true);
   const name=decode.decode(bytes.subarray(offset+46,offset+46+length));offset+=46+length+extra+comment;
   total+=expanded;if(total>MAX||expanded>MAX||flags&1||![0,8].includes(method)||out.has(name))throw Error('Excel 過大、已加密或使用不支援的壓縮格式。');
   if(!/^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name))continue;
   if(local+30>bytes.length||v.getUint32(local,true)!==0x04034b50)throw Error('Excel 檔案內容損毀。');
   const start=local+30+v.getUint16(local+26,true)+v.getUint16(local+28,true);
   if(start+size>bytes.length)throw Error('Excel 檔案不完整。');
   const data=bytes.slice(start,start+size);let result=data;
   if(method===8){const reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),parts=[];let sizeRead=0;while(true){const chunk=await reader.read();if(chunk.done)break;sizeRead+=chunk.value.length;if(sizeRead>expanded||sizeRead>MAX){await reader.cancel();throw Error('Excel 解壓縮大小超過限制。');}parts.push(chunk.value);}result=new Uint8Array(sizeRead);let at=0;for(const part of parts){result.set(part,at);at+=part.length;}}
   if(result.length!==expanded)throw Error('Excel 解壓縮長度不符。');out.set(name,decode.decode(result));
  }
  return out;
 }
 const xml=text=>{if(!text||/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Excel XML 格式不支援。');const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw Error('Excel XML 格式損毀。');return doc;};
 const nodes=(doc,name)=>[...doc.getElementsByTagNameNS('*',name)];
 async function read(file){
  if(!/\.xlsx$/i.test(file.name))throw Error('請選擇 .xlsx 格式。');const zip=await files(await file.arrayBuffer());
  const workbook=xml(zip.get('xl/workbook.xml')),first=nodes(workbook,'sheet')[0];if(!first)throw Error('Excel 沒有工作表。');
  const relationship=first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
  const relation=nodes(xml(zip.get('xl/_rels/workbook.xml.rels')),'Relationship').find(r=>r.getAttribute('Id')===relationship);
  const target=relation?.getAttribute('Target')||'';if(relation?.getAttribute('TargetMode')==='External')throw Error('不支援外部工作表。');
  const path=target.startsWith('/')?target.slice(1):'xl/'+target.replace(/^\.\//,'');if(path.includes('..'))throw Error('工作表路徑無效。');
  const shared=zip.has('xl/sharedStrings.xml')?nodes(xml(zip.get('xl/sharedStrings.xml')),'si').map(si=>nodes(si,'t').map(n=>n.textContent).join('')):[];
  const rows=nodes(xml(zip.get(path)),'row');if(rows.length>102)throw Error('每次最多匯入 100 筆，請使用第一列作為標題。');
  return rows.map(row=>{const cells=[];for(const c of nodes(row,'c')){if(nodes(c,'f').length)throw Error('對照匯入不接受公式，請貼上純值後重試。');const ref=c.getAttribute('r')||'',letters=ref.match(/^[A-Z]+/)?.[0];if(!letters)throw Error('Excel 儲存格位置無效。');let index=0;for(const char of letters)index=index*26+char.charCodeAt(0)-64;if(index>50)throw Error('匯入範本最多支援 50 欄。');const value=nodes(c,'v')[0]?.textContent||'';cells[index-1]=c.getAttribute('t')==='s'?shared[Number(value)]||'':c.getAttribute('t')==='inlineStr'?nodes(c,'t').map(n=>n.textContent).join(''):value;}return cells;});
 }
 globalThis.GucAliasXlsx={read};
})();
