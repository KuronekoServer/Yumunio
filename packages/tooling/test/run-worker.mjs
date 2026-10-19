import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = file => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, file, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Worker test command failed (${signal || code}).`)));
});
try {
  await run([resolve(root, 'packages/tooling/build-web.mjs')]);
  await run(['--test', resolve(root, 'apps/worker/integration/setup.mjs')]);
  await run(['--test', resolve(root, 'apps/worker/integration/realtime-room.mjs')]);
  await run(['--test', resolve(root, 'apps/worker/integration/clipboard.mjs')]);
  await run(['--test', resolve(root, 'apps/worker/integration/mail.mjs')]);
  await run(['--test', '--test-concurrency=1', ...process.argv.slice(2), resolve(root, 'apps/worker/integration/public-forms.mjs'), resolve(root, 'apps/worker/integration/webhook-lifecycle.mjs')]);
  await run(['--test', '--test-concurrency=1', ...process.argv.slice(2), resolve(root, 'apps/worker/integration/runtime.mjs'), resolve(root, 'apps/worker/integration/backup.mjs'), resolve(root, 'apps/worker/integration/pwa.mjs'), resolve(root, 'apps/worker/integration/charts.mjs'), resolve(root, 'apps/worker/integration/feed.mjs'), resolve(root, 'apps/worker/integration/webhooks.mjs'), resolve(root, 'apps/worker/integration/mcp.mjs'), resolve(root, 'apps/worker/integration/room-renew.mjs'), resolve(root, 'apps/worker/integration/room-focus.mjs'), resolve(root, 'apps/worker/integration/room-presence.mjs'), resolve(root, 'apps/worker/integration/import-capacity.mjs'), resolve(root, 'apps/worker/integration/block-forest.mjs'), resolve(root, 'apps/worker/integration/teamspaces.mjs'), resolve(root, 'apps/worker/integration/board-order.mjs'), resolve(root, 'apps/worker/integration/content-capacity.mjs'), resolve(root, 'apps/worker/integration/property-conversion.mjs'),resolve(root,'apps/worker/integration/structured-room.mjs'),resolve(root,'apps/worker/integration/backup-maintenance.mjs'),resolve(root,'apps/worker/integration/assignment.mjs')]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
