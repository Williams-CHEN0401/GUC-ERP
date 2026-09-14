// Loopback-only synthetic data, no access to production services.
import {createPreviewServer,fixture} from './report-dates-preview-server.mjs';
fixture.customers[0].name='分類測試學校（模擬資料）';
fixture.customers[0].row_version=1;
export {createPreviewServer};
if(process.argv[1]?.endsWith('customer-categories-preview-server.mjs')){
 createPreviewServer().listen(4194,'127.0.0.1',()=>console.log('http://127.0.0.1:4194/?page=crm — synthetic data only'));
}
