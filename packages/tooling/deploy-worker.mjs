import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initialSetupUrl } from '../identity/src/setup.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
function command(args, { quiet = false } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (!quiet) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; if (!quiet) process.stderr.write(chunk); });
    child.once('error', reject); child.once('exit', code => resolveCommand({ code, stdout, stderr }));
  });
}
/** Existing installation credentials are preserved. Failed authorization never resets them. */
export async function deployWorker({ run = command, log = console.log, env = process.env } = {}) {
  const listed = await run(['secret', 'list', '--format', 'json'], { quiet: true });
  let secrets;
  if (listed.code === 0) {
    try { secrets = JSON.parse(listed.stdout); } catch { throw new Error('Unable to inspect the existing installation.'); }
    if (!Array.isArray(secrets) || secrets.some(item => !item || typeof item.name !== 'string')) throw new Error('Invalid installation response.');
  } else if (/Worker "[^"\r\n]+"(?: \(env:[^)]*\))? not found\./.test(listed.stderr + listed.stdout)) secrets = [];
  else throw new Error('Unable to inspect the existing installation. Check Cloudflare access; no credentials were changed.');
  const installed = secrets.some(item => ['YUMUNIO_INSTANCE_SECRET', 'YUMUNIO_SETUP_TOKEN'].includes(item.name));
  const migration = await run(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (migration.code !== 0) throw new Error('Database preparation failed.');
  if (!installed) {
    const inspection = await run(['d1', 'execute', 'DB', '--remote', '--json', '--command', 'SELECT (SELECT COUNT(*) FROM yumunio_instance_settings) + (SELECT COUNT(*) FROM yumunio_users) AS total'], { quiet: true });
    let total;
    try { const results = JSON.parse(inspection.stdout); total = results[0].results[0].total; } catch { throw new Error('Unable to inspect installation data. No credentials were changed.'); }
    if (inspection.code !== 0 || total !== 0) throw new Error('Existing installation data requires its original credentials. No credentials were changed.');
  }
  let directory;
  try {
    const args = ['deploy']; let generated;
    if (!installed) {
      generated = randomBytes(48).toString('base64url');
      directory = await mkdtemp(join(tmpdir(), 'yumunio-deploy-'));
      const file = join(directory, 'credentials.json');
      await writeFile(file, JSON.stringify({ YUMUNIO_INSTANCE_SECRET: generated }), { mode: 0o600 });
      args.push('--secrets-file', file);
    }
    const deployment = await run(args);
    if (deployment.code !== 0) throw new Error('Worker deployment failed.');
    if (generated) {
      const origin = env.YUMUNIO_PUBLIC_ORIGIN || deployment.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
      if (!origin) throw new Error('Worker deployed. Open the deployment log to locate its URL and complete installation.');
      log('初期設定をはじめる / Start setup: ' + await initialSetupUrl({ YUMUNIO_INSTANCE_SECRET: generated }, origin));
    }
  } finally {
    if (directory) {
      const rel = relative(resolve(tmpdir()), resolve(directory));
      if (isAbsolute(rel) || rel.includes(sep) || !rel.startsWith('yumunio-deploy-')) throw new Error('Unexpected temporary directory.');
      await rm(directory, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await deployWorker(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
