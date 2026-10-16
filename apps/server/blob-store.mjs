import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { BlobStoreError, MAX_BLOB_BYTES, blobKey, createS3BlobStore, readBlobConfig, sha256, storageProfile } from '../../packages/adapters/src/blob.js';

const unavailable = () => new BlobStoreError();
async function directoryTree(path) {
  const absolute = resolve(path), parts = [];
  let cursor = absolute;
  while (cursor !== parse(cursor).root) { parts.unshift(basename(cursor)); cursor = dirname(cursor); }
  for (const part of parts) {
    cursor = join(cursor, part);
    try { await mkdir(cursor); } catch (error) { if (error.code !== 'EEXIST') throw unavailable(); }
    const item = await lstat(cursor);
    if (!item.isDirectory() || item.isSymbolicLink()) throw unavailable();
  }
  const canonical = await realpath(absolute);
  if (canonical.toLowerCase() !== absolute.toLowerCase()) throw unavailable();
  return absolute;
}

/** Flat hashed filenames, exclusive creation, and no client-provided filesystem paths. */
export async function createLocalBlobStore(config) {
  const root = await directoryTree(config.directory), profileId = await storageProfile({ driver: 'local', directory: root });
  async function destination(key) {
    blobKey(key);
    const item = await lstat(root);
    if (!item.isDirectory() || item.isSymbolicLink() || (await realpath(root)).toLowerCase() !== root.toLowerCase()) throw unavailable();
    return join(root, await sha256(new TextEncoder().encode(key)));
  }
  return Object.freeze({ profileId,
    async put(key, input) {
      if (!(input instanceof Uint8Array) || input.length > MAX_BLOB_BYTES) throw new BlobStoreError('BLOB_TOO_LARGE');
      const bytes = input.slice(), target = await destination(key); let handle;
      try {
        handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
        await handle.writeFile(bytes); await handle.sync();
        return { size: bytes.length, checksum: await sha256(bytes) };
      } catch (error) {
        if (error.code === 'EEXIST') throw new BlobStoreError('BLOB_EXISTS');
        if (handle) { try { await unlink(target); } catch {} }
        throw unavailable();
      } finally { await handle?.close(); }
    },
    async get(key) {
      const target = await destination(key); let handle;
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BLOB_BYTES) throw unavailable();
        handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size !== info.size || opened.ino !== info.ino || opened.dev !== info.dev) throw unavailable();
        const bytes = new Uint8Array(opened.size);
        let offset = 0;
        while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw unavailable(); offset += result.bytesRead; }
        if ((await handle.stat()).size !== opened.size) throw unavailable();
        return bytes;
      } catch (error) { if (error.code === 'ENOENT') return null; throw unavailable(); }
      finally { await handle?.close(); }
    },
    async delete(key) {
      const target = await destination(key);
      try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw unavailable(); await unlink(target); }
      catch (error) { if (error.code !== 'ENOENT') throw unavailable(); }
    }
  });
}
export async function createNodeBlobStore(env) {
  const config = readBlobConfig(env, { runtime: 'node' });
  if (config.driver === 'disabled') return null;
  if (config.driver === 's3') return createS3BlobStore(config);
  return createLocalBlobStore(config);
}
