import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PreferencesStore, THEMES, FONT_OPTIONS, normalizeColor, contrastRatio, validateCustomColors } from '../public/preferences.js';
class MemoryStorage { data = new Map(); getItem(key) { return this.data.get(key) ?? null; } setItem(key, value) { this.data.set(key, value); } }
test('six runtime palettes preserve every canonical design role', async () => {
  const source = JSON.parse(await readFile(new URL('./fixtures/themes.json', import.meta.url), 'utf8'));
  assert.equal(THEMES.length, 6);
  for (const preset of source.presets) {
    const theme = THEMES.find(item => item.id === preset.id);
    assert.equal(theme.kind, preset.kind);
    for (const [role, value] of Object.entries(theme.colors)) assert.equal(value, preset[role], `${preset.id}/${role}`);
    assert.equal(validateCustomColors(theme.id).valid, true, theme.id);
  }
  const fonts = JSON.parse(await readFile(new URL('./fixtures/font-options.json', import.meta.url), 'utf8'));
  assert.deepEqual(FONT_OPTIONS.map(font => font.id).sort(), fonts.options.map(font => font.id).sort());
});
test('color normalization rejects injection, transparency and invalid ranges', () => {
  assert.equal(normalizeColor('#abc'), '#AABBCC');
  assert.equal(normalizeColor(' rgb(56, 87, 114) '), '#385772');
  for (const input of ['transparent', '#abcdef00', 'rgb(256,0,0)', 'rgba(0,0,0,1)', 'red; color:white', 'var(--x)', '#abz']) assert.throws(() => normalizeColor(input));
  assert.equal(contrastRatio('#000', '#fff'), 21);
});
test('invalid or low-contrast changes never overwrite stored preferences', () => {
  const storage = new MemoryStorage();
  const prefs = new PreferencesStore({ storage });
  prefs.update({ themeId: 'midnight', locale: 'en' });
  const before = storage.getItem(prefs.key);
  assert.throws(() => prefs.update({ customColors: { text: '#131C2B' } }), /LOW_CONTRAST/);
  assert.throws(() => prefs.update({ fontId: 'url(https://example.com)' }), /INVALID_PREFERENCES/);
  assert.equal(storage.getItem(prefs.key), before);
  assert.equal(prefs.snapshot().themeId, 'midnight');
});
test('profiles are separate from one another and from workspace snapshots', () => {
  const storage = new MemoryStorage();
  storage.setItem('yumunio.local-demo.v1', 'workspace-content');
  const local = new PreferencesStore({ storage });
  const other = new PreferencesStore({ storage, profileId: 'member-2' });
  local.update({ themeId: 'forest', fontId: 'line-seed-jp', locale: 'en' });
  assert.equal(other.snapshot().themeId, 'light');
  other.update({ themeId: 'ocean' });
  local.reset();
  assert.equal(new PreferencesStore({ storage, profileId: 'member-2' }).snapshot().themeId, 'ocean');
  assert.equal(storage.getItem('yumunio.local-demo.v1'), 'workspace-content');
});
test('corrupt preferences fall back without deleting stored values; failed writes keep current settings', () => {
  const storage = new MemoryStorage();
  storage.setItem('yumunio.preferences.v1:local', '{bad');
  const prefs = new PreferencesStore({ storage });
  assert.equal(prefs.error, 'PREFERENCES_READ_FAILED');
  assert.equal(prefs.snapshot().locale, 'ja');
  assert.equal(storage.getItem(prefs.key), '{bad');
  const blocked = new PreferencesStore({ storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } } });
  assert.throws(() => blocked.update({ themeId: 'forest' }), /PREFERENCES_SAVE_FAILED/);
  assert.equal(blocked.snapshot().themeId, 'light');
});
test('valid custom colors normalize on persistence and expose contrast pairs', () => {
  const prefs = new PreferencesStore({ storage: new MemoryStorage() });
  prefs.update({ customColors: { accent: 'rgb(35, 85, 142)', canvas: '#fff', text: '#111' } });
  const result = validateCustomColors(prefs.snapshot().themeId, prefs.snapshot().customColors);
  assert.equal(prefs.snapshot().customColors.accent, '#23558E');
  assert.equal(result.valid, true);
  assert.ok(result.contrast['text/nav'] >= 4.5);
  assert.ok(result.contrast['disabledFg/disabledBg'] >= 3);
});
