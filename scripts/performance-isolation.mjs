// Local synthetic stack only. Never reads .env or credentials from other projects.
import {randomBytes,createHmac} from 'node:crypto';
import {mkdir,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const dir=path.join(root,'tmp/performance');await mkdir(dir,{recursive:true});
try{await access(path.join(dir,'.env'));throw Error('Test configuration already exists; reuse it instead of rotating keys under a running stack.');}catch(error){if(error.code!=='ENOENT')throw error;}
const secret=randomBytes(48).toString('hex'),password=randomBytes(24).toString('hex');
function jwt(role){const body=[{alg:'HS256',typ:'JWT'},{role,iss:'supabase',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+604800}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');}
const service=jwt('service_role');
await writeFile(path.join(dir,'.env'),`TEST_DB_PASSWORD=${password}\nTEST_JWT_SECRET=${secret}\nTEST_SERVICE_KEY=${service}\n`);
await writeFile(path.join(dir,'test-credentials.json'),JSON.stringify({password,secret,service}));
await writeFile(path.join(dir,'compose.yaml'),`name: guc-performance-test
services:
  db:
    image: supabase/postgres:17.6.1.136
    environment:
      POSTGRES_PASSWORD: \${TEST_DB_PASSWORD}
      JWT_SECRET: \${TEST_JWT_SECRET}
      JWT_EXP: 3600
      POSTGRES_DB: postgres
    command: [postgres, -D, /var/lib/postgresql/data, -c, listen_addresses=*]
    volumes: [test-db:/var/lib/postgresql/data]
    ports: ['127.0.0.1:55446:5432']
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U postgres']
      interval: 2s
      retries: 30
  auth:
    image: supabase/gotrue:v2.196.0
    depends_on:
      db: {condition: service_healthy}
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      API_EXTERNAL_URL: http://api-gw:8000
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:\${TEST_DB_PASSWORD}@db:5432/postgres
      GOTRUE_SITE_URL: http://localhost:4268
      GOTRUE_JWT_SECRET: \${TEST_JWT_SECRET}
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_DISABLE_SIGNUP: 'true'
      GOTRUE_MAILER_AUTOCONFIRM: 'true'
  rest:
    image: postgrest/postgrest:v14.17
    depends_on:
      db: {condition: service_healthy}
    environment:
      PGRST_DB_URI: postgres://authenticator:\${TEST_DB_PASSWORD}@db:5432/postgres
      PGRST_DB_SCHEMAS: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${TEST_JWT_SECRET}
      PGRST_DB_MAX_ROWS: 2000
  api-gw:
    image: guc-local/erp:2026-10-10
    command: [node, /workspace/scripts/performance-router.mjs]
    volumes: ['${root.replaceAll('\\','/')}:/workspace:ro']
  gateway:
    image: supabase/edge-runtime:v1.76.2
    command: [start, --main-service, /home/deno/functions/inventory-gateway]
    environment:
      SUPABASE_URL: http://api-gw:8000
      SUPABASE_SERVICE_ROLE_KEY: \${TEST_SERVICE_KEY}
      GUC_PERFORMANCE_ENABLED: 'true'
    volumes: ['${root.replaceAll('\\','/')}\/supabase/functions:/home/deno/functions:ro']
    networks:
      default: {aliases: [guc-supabase-functions]}
  erp:
    image: guc-local/erp:2026-10-10
    working_dir: /workspace
    command: [node, docker/server.mjs]
    environment:
      GUC_LOCAL_DOCKER: 'true'
      GUC_LOCAL_SUPABASE: 'true'
      VERCEL_ENV: production
      SUPABASE_FUNCTIONS_URL: http://guc-supabase-functions:9000
      GUC_PERFORMANCE_ENABLED: 'true'
      ERP_PUBLIC_URL: http://localhost:4268/
      PORT: 3000
    volumes: ['${root.replaceAll('\\','/')}:/workspace:ro', '${dir.replaceAll('\\','/')}:/test-output']
    ports: ['127.0.0.1:4268:3000']
    networks: [default, browser]
volumes:
  test-db:
networks:
  default:
    internal: true
  browser:
    labels: {purpose: synthetic-performance-browser}
`);
console.log('Prepared guc-performance-test: private network, fresh random keys, dedicated volume, loopback ports.');
