/** Public deployment settings shared by the Fetch API and both runtime entries. */
export function validatePublicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Use an exact HTTP(S) public origin.'); }
  if (typeof value !== 'string' || value !== url.origin || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Use an exact HTTP(S) public origin.');
  }
  return url.origin;
}

export function isValidAccessKey(value) {
  return typeof value === 'string' && value.length >= 32 && value.length <= 4096;
}
