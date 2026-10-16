import { createR2BlobStore, createS3BlobStore, readBlobConfig } from '../../packages/adapters/src/blob.js';

export async function createWorkerBlobStore(env) {
  const config = readBlobConfig(env, { runtime: 'worker' });
  if (config.driver === 'disabled') return null;
  if (config.driver === 's3') return createS3BlobStore(config);
  return createR2BlobStore(env[config.binding], config);
}
