// Disposable native localhost PostgreSQL, synthetic data only; no production URL or credentials.
// Usage: node scripts/verify-edit-inline-items-postgres.mjs   (PG_BIN may point at the PostgreSQL bin directory)
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const migrationDir=path.join(root,'supabase/migrations');
const read=name=>readFileSync(name,'utf8').replaceAll('\r\n','\n');
function pgBin(){
  const candidates=[process.env.PG_BIN];
  const base='/usr/lib/postgresql';
  if(existsSync(base))candidates.push(...readdirSync(base).sort((a,b)=>Number(b)-Number(a)).map(v=>path.join(base,v,'bin')));
  try{candidates.push(execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim());}catch{}
  const found=candidates.find(dir=>dir&&existsSync(path.join(dir,'initdb'))&&existsSync(path.join(dir,'pg_ctl')));
  if(!found)throw Error('PostgreSQL server binaries (initdb, pg_ctl) not found; set PG_BIN.');
  return found;
}
// Extract the latest real definition of a function from the migrations.
function latestDefinition(name){
  let found=null;
  for(const file of readdirSync(migrationDir).filter(f=>f.endsWith('.sql')).sort()){
    const source=read(path.join(migrationDir,file)),pattern=new RegExp('create (?:or replace )?function public\\.'+name+'\\b','ig');
    for(const match of source.matchAll(pattern)){
      const tail=source.slice(match.index),body=/\bas\s+(\$[a-z_]*\$)/i.exec(tail),end=tail.indexOf(body[1],body.index+body[0].length);
      found={file,sql:tail.slice(0,tail.indexOf(';',end+body[1].length)+1).replace(/^create function/i,'create or replace function')};
    }
  }
  if(!found)throw Error('Missing function '+name);
  return found;
}
const bin=pgBin(),cluster=mkdtempSync(path.join(tmpdir(),'guc-edit-inline-')),data=path.join(cluster,'data'),port=String(55400+Math.floor(Math.random()*90));
chmodSync(cluster,0o777);
// initdb refuses root; run the disposable cluster as the postgres OS user when needed.
const asUser=process.getuid?.()===0?['runuser','-u','postgres','--']:[];
const run=(cmd,args,options={})=>{
  const full=[...asUser,path.join(bin,cmd),...args],result=spawnSync(full[0],full.slice(1),{encoding:'utf8',...options});
  if(result.status!==0)throw Error(`${cmd} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout+result.stderr;
};
let started=false;
try{
  run('initdb',['-D',data,'--username=postgres','--auth=trust','--locale=C','--encoding=UTF8']);
  run('pg_ctl',['-D',data,'-l',path.join(cluster,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${cluster}`,'-w','start']);started=true;
  const itemCreator=latestDefinition('create_inventory_items_batch_v1');
  const files=[
    ['baseline',read(path.join(root,'scripts/fixtures/edit-inline-items-baseline.sql'))],
    ['create_inventory_items_batch_v1 from '+itemCreator.file,itemCreator.sql],
    ['migration',read(path.join(migrationDir,'20261126120959_edit_documents_inline_items.sql'))],
    ['assertions',read(path.join(root,'scripts/fixtures/edit-inline-items-verify.sql'))],
  ];
  let passed=0;
  for(const [label,sql] of files){
    const file=path.join(cluster,label.replace(/\W+/g,'_')+'.sql');writeFileSync(file,sql);chmodSync(file,0o644);
    const output=run('psql',['-X','-q','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres','-f',file]);
    for(const line of output.split('\n').filter(l=>/PASS/.test(l))){console.log(line.replace(/^.*NOTICE:\s*/,''));passed++;}
    console.log('applied '+label);
  }
  if(passed<13)throw Error(`expected at least 13 passing assertions, got ${passed}`);
  console.log(`OK ${passed} assertions passed on isolated PostgreSQL`);
}finally{
  if(started)try{run('pg_ctl',['-D',data,'-m','fast','-w','stop']);}catch{}
  rmSync(cluster,{recursive:true,force:true});
}
