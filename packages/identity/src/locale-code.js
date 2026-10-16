export function canonicalLocale(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 63 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) throw new TypeError('INVALID_LOCALE');
  try { return Intl.getCanonicalLocales(value)[0]; } catch { throw new TypeError('INVALID_LOCALE'); }
}
export function isLocaleTag(value) { try { canonicalLocale(value); return true; } catch { return false; } }
