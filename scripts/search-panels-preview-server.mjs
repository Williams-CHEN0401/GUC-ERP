// Reuse isolated fixtures; GET only, no production credentials or outbound requests.
import {pickupNotesServer} from './pickup-notes-fixture.mjs';
export async function searchPanelServer(){
  const fixture=await pickupNotesServer(),{server,snapshot}=fixture;
  const original=server.listeners('request')[0],queries=[],mutations=[];
  server.removeListener('request',original);
  server.on('request',async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if(req.method!=='GET'){mutations.push(req.url);json(403,{error:'搜尋介面隔離預覽僅供查詢，不接受寫入。'});return;}
    if(url.pathname==='/__search_test'){json(200,{queries,mutations});return;}
    if(url.pathname==='/api/nas'){json(403,{error:'唯讀隔離預覽不連線 NAS。'});return;}
    if(url.pathname==='/api/inventory'){
      if(url.searchParams.get('entity')==='audit_logs'){
        queries.push(Object.fromEntries(url.searchParams));
        const rows=Array.from({length:52},(_,i)=>({id:i+1,created_at:new Date(Date.UTC(2026,8,1,0,i)).toISOString(),action:'update',actor:'隔離排序測試員',entity_type:'customers',entity_id:'sort-fixture',before_data:{name:'舊名稱'},after_data:{name:'測試'+(i+1)}}));
        const direction=url.searchParams.get('sort_direction')||'desc',page=Number(url.searchParams.get('page')||1),size=Number(url.searchParams.get('page_size')||25);
        rows.sort((a,b)=>direction==='asc'?a.id-b.id:b.id-a.id);
        json(200,{records:rows.slice((page-1)*size,page*size),pagination:{total:rows.length,page_count:Math.ceil(rows.length/size)}});return;
      }
      try{
        const data=await snapshot(url.searchParams.get('scope')||'session');
        data.accounts=[{id:'test-search-user',username:'search-demo',display_name:'搜尋介面測試員',role:'admin',is_active:true}];
        data.suppliers=[{id:'search-supplier',name:'篩選測試供應商',contact_name:'測試窗口',phone:'00000000'}];
        data.receipts=[{id:'search-receipt',receipt_date:'2026-09-26',supplier_id:'search-supplier',inventory_item_id:data.items[0].id,quantity:2,note:'搜尋進貨範例'}];
        data.repair_items=[{id:'search-repair',repair_no:'TEST-R001',received_on:'2026-09-26',customer_id:data.customers[0].id,inventory_item_id:data.items[0].id,issue_description:'搜尋維修範例',status:'received'}];
        data.projects.push({id:'search-construction',name:'搜尋工程範例',project_code:'TEST-P001',customer_id:data.customers[0].id,project_type:'construction',construction_category:'small_purchase',status:'in_progress'});
        json(200,data);
      }catch(error){json(500,{error:error.message});}
      return;
    }
    original(req,res);
  });
  return fixture;
}
if(process.argv[1]?.endsWith('search-panels-preview-server.mjs')){
  const {server}=await searchPanelServer(),port=Number(process.env.SEARCH_PANEL_PORT||4226);
  server.listen(port,'127.0.0.1',()=>console.log(`ERP read-only isolated search preview: http://127.0.0.1:${port}/?page=worklogs`));
}
