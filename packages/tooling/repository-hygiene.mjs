import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const localDirectories = new Set([
  '.build', '.data', '.wrangler', '.next', '.npm-cache', '.crowdin', '.ssh', 'node_modules'
]);

function privatePathReason(path) {
  const parts = path.split('/');
  const name = parts.at(-1);
  if (parts.some(part => localDirectories.has(part.toLowerCase()))) return 'local or generated directory';
  if (/^(?:\.env(?:\.|$)|\.dev\.vars)/i.test(name) && !name.endsWith('.example')) return 'local environment file';
  if (/\.(?:pen|zip|sqlite(?:-shm|-wal)?|db(?:-shm|-wal)?|log)$/i.test(name)) return 'local data, design original or generated archive';
  if (path === 'apps/worker/wrangler.deploy.jsonc') return 'local deployment configuration';
  return null;
}

// Deliberately limited to recognizable formats. Errors never print matching values.
const credentialRules = [
  ['private key material', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{40,}-----END (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{80,255})\b/],
  // Preserve the published SigV4 example already used by the adapter tests.
  ['AWS access key identifier', /\b(?:AKIA(?!IOSFODNN7EXAMPLE\b)|ASIA)[A-Z0-9]{16}\b/]
];

/** Inspect the Git index, including staged bytes hidden by later worktree edits. */
export function checkRepository(root = projectRoot) {
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options
  });
  const index = git(['ls-files', '--stage', '-z']).toString('utf8');
  const entries = index.split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(line);
    if (!match) throw Error('Unable to inspect the Git index.');
    return {mode: match[1], object: match[2], stage: Number(match[3]), path: match[4]};
  });
  if (!entries.length) throw Error('The Git index is empty; no repository was checked.');

  const problems = [];
  const objects = new Map();
  for (const entry of entries) {
    const reason = privatePathReason(entry.path);
    if (reason) problems.push({path: entry.path, reason});
    if (entry.stage !== 0) problems.push({path: entry.path, reason: 'unresolved merge'});
    if (!['100644', '100755'].includes(entry.mode)) {
      problems.push({path: entry.path, reason: 'symlink or submodule requires an explicit publication policy'});
      continue;
    }
    if (reason || entry.stage !== 0) continue;
    if (!objects.has(entry.object)) objects.set(entry.object, []);
    objects.get(entry.object).push(entry.path);
  }

  if (objects.size) {
    const output = git(['cat-file', '--batch'], {input: [...objects.keys()].join('\n') + '\n'});
    let offset = 0;
    for (const [object, paths] of objects) {
      const end = output.indexOf(10, offset);
      const header = output.subarray(offset, end).toString('ascii').split(' ');
      const size = Number(header[2]);
      if (end < 0 || header[0] !== object || header[1] !== 'blob' ||
          !Number.isSafeInteger(size) || size < 0 || end + size + 1 >= output.length) {
        throw Error('Unable to inspect an indexed file.');
      }
      const source = output.subarray(end + 1, end + 1 + size).toString('utf8');
      for (const [reason, pattern] of credentialRules) {
        if (pattern.test(source)) for (const path of paths) problems.push({path, reason});
      }
      offset = end + size + 2;
    }
    if (offset !== output.length) throw Error('Unexpected indexed file response.');
  }
  return {files: entries.length, checkedBlobs: objects.size, problems};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = checkRepository();
    if (report.problems.length) {
      console.error('Repository publication check failed: ' + JSON.stringify(report.problems));
      process.exitCode = 1;
    } else console.log('Repository index checked: ' + JSON.stringify(report));
  } catch {
    console.error('Unable to check the repository index. Run this command in a Git checkout.');
    process.exitCode = 1;
  }
}
