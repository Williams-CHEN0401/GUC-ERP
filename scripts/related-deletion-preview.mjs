
import {pathToFileURL} from 'node:url';
import {pendingContextServer} from './worklog-pending-context-fixture.mjs';
import {definition,sql} from './worklog-save-fixture.mjs';

export async function relatedDeletionServer() {
  const fixture = await pendingContextServer();
  try {
    await fixture.db.exec(`
      alter table public.inventory_items add column if not exists legacy_unit text,
        add column if not exists meters_per_unit numeric, add column if not exists opening_meters numeric;
      alter table public.pickup_records add column if not exists remnant_line_id uuid,
        add column if not exists package_unit_snapshot text;
    `);
    const migration = await sql('20261125135502_allow_archive_with_related_history.sql');
    for (const name of ['guard_maintenance_pending_log_v1', 'guard_work_log_pending_history_v1']) {
      await fixture.db.exec(definition(migration, name));
    }
    return fixture;
  } catch (error) {
    fixture.server.close();
    await fixture.db.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.WORKLOG_TEST_PORT || 4525);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid isolated preview port');
  const {server} = await relatedDeletionServer();
  server.listen(port, '127.0.0.1', () => console.log('http://localhost:' + port + '/?page=worklogs'));
}
