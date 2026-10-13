// Nonnegative decimal arithmetic matching PostgreSQL numeric round(..., 0).
// Tax defaults come from the existing server-side quotation money settings.
(function(root){
 'use strict';
 const round=(n,d)=>(n+d/2n)/d;
 function cents(value){const text=String(value);if(!/^\d+(\.\d{1,2})?$/.test(text))throw Error('金額最多兩位小數。');const [a,b='']=text.split('.');return BigInt(a)*100n+BigInt(b.padEnd(2,'0'));}
 function calculate(lines,mode,rate){
  if(mode!==null&&!['exclusive','inclusive'].includes(mode))throw Error('計價模式不正確。');
  if((mode===null)!==(rate===null)||rate!==null&&(!Number.isInteger(rate)||rate<0||rate>10000))throw Error('稅率須為 0 至 100%，最多兩位小數。');
  let input=0n,missing=0;
  for(const line of lines){if(!Number.isSafeInteger(Number(line.quantity))||Number(line.quantity)<=0)throw Error('數量須為正整數。');if(line.unit_price==null||line.unit_price===''){missing++;continue;}const price=cents(line.unit_price);if(price>=100000000000000n)throw Error('單價超過上限。');input+=round(price*BigInt(line.quantity),100n);}
  let net=null,tax=null,total=null;
  if(mode&&missing===0){if(mode==='inclusive'){total=input;net=round(total*10000n,10000n+BigInt(rate));tax=total-net;}else{net=input;tax=round(net*BigInt(rate),10000n);total=net+tax;}}
  const safe=n=>{if(n===null)return null;if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('單據金額超過可精確計算的上限。');return Number(n);};
  return {mode,tax_rate_basis_points:rate,currency:'TWD',currency_scale:0,input_amount:safe(input),net_amount:safe(net),tax_amount:safe(tax),total_amount:safe(total),missing_price_count:missing};
 }
 root.GUCReceiptMoney=Object.freeze({calculate,rateBasisPoints:value=>Number(cents(value))});
})(globalThis);
