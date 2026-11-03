// Existing domain unit tests replace currentUser and bypass its real permission
// hydration. Supply website access explicitly to those old Auth stubs. Website
// allow/deny itself is tested with the real Gateway and PostgreSQL fixtures.
export const withWebsiteAccess=resolve=>async(...args)=>{
 const user=await resolve(...args);
 return user?{...user,website_access:user.website_access??Object.fromEntries(['erp','accounting','site'].map(site=>[site,{visible:true,login:true}]))}:null;
};
