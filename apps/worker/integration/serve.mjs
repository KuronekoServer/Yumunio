import { unstable_startWorker } from 'wrangler';

const [config, persist, port] = process.argv.slice(2);
let worker;
let starting;
let stopping;
let stopRequested = false;
async function stop() {
  stopRequested = true;
  if (stopping) return stopping;
  stopping = (async () => {
    try {
      // A stop can arrive before unstable_startWorker has returned its handle.
      // Wait for that handle before disposal; the owning fixture bounds this wait.
      try { if (!worker && starting) worker = await starting; } catch {}
      await worker?.dispose();
    } finally {
      if (process.connected) process.disconnect();
    }
  })();
  return stopping;
}
const reportStopFailure = error => { console.error(error); process.exitCode = 1; };
process.on('message', message => {
  if (message?.type === 'stop') stop().catch(reportStopFailure);
});
process.once('disconnect', () => { stop().catch(reportStopFailure); });
try {
  starting = unstable_startWorker({
    config,
    dev: { remote: false, server: { hostname: '127.0.0.1', port: Number(port) }, persist, watch: false, inspector: false, logLevel: 'warn' },
  });
  worker = await starting;
  if (stopRequested) await stop();
  else {
    await worker.ready;
    if (!stopRequested && process.connected) process.send({ type: 'ready', url: String(await worker.url) });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop().catch(reportStopFailure);
}
