import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createI18n, loadCatalogs, validateCatalogParity } from '../public/i18n.js';
const ja = JSON.parse(await readFile(new URL('../public/locales/ja.json', import.meta.url), 'utf8'));
const en = JSON.parse(await readFile(new URL('../public/locales/en.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../public/locale-manifest.json', import.meta.url), 'utf8'));
test('community catalogs have matching keys and named placeholders', () => {
  assert.deepEqual(validateCatalogParity(ja, en), { valid: true, missing: [], extra: [], placeholderMismatches: [] });
  const invalid = validateCatalogParity({ a: '{name}', b: 'x' }, { a: '{value}', c: 'y' });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.missing, ['b']);
  assert.deepEqual(invalid.extra, ['c']);
  assert.deepEqual(invalid.placeholderMismatches, ['a']);
});
test('labels and parameterized descriptions translate without evaluating markup', () => {
  const i18n = createI18n({ ja, en }, 'en');
  assert.equal(i18n.text('ページを作成'), 'Create page');
  assert.equal(i18n.text('8件表示 · 全12件'), '8 shown · 12 total');
  assert.equal(i18n.t('common.openPage', { title: '<img onerror=alert(1)>' }), 'Open <img onerror=alert(1)>');
  assert.equal(i18n.text('Unrecognized text'), 'Unrecognized text');
  i18n.setLocale('ja');
  assert.equal(i18n.text('ページを作成'), 'ページを作成');
  assert.throws(() => i18n.setLocale('unknown'), /INVALID_LOCALE/);
});
test('missing translation uses explicit Japanese source fallback', () => {
  const i18n = createI18n({ ja: { title: '原文' }, en: {} }, 'en');
  assert.equal(i18n.t('title'), '原文');
});
test('catalog loader requires successful flat JSON catalogs', async () => {
  const catalogs = await loadCatalogs(async url => Response.json(url.pathname.endsWith('locale-manifest.json') ? manifest : url.pathname.endsWith('ja.json') ? ja : en));
  assert.equal(catalogs.en['nav.home'], 'Home');
  await assert.rejects(loadCatalogs({manifest,fetcher:async () => new Response(null,{status:503})}), /CATALOG_UNAVAILABLE/);
  await assert.rejects(loadCatalogs({manifest,fetcher:async () => Response.json({bad:{}})}), /INVALID_CATALOG/);
});

test('bundled dictionaries preserve validation and language switching without startup catalog requests',async()=>{
 const catalogs=await loadCatalogs({manifest,initialCatalogs:{ja,en},fetcher:()=>assert.fail('Bundled source and fallback need no HTTP request')});
 const i18n=createI18n(catalogs,'ja');assert.equal(i18n.t('nav.home'),ja['nav.home']);await i18n.switchLocale('en');assert.equal(i18n.t('nav.home'),'Home');
 await assert.rejects(loadCatalogs({manifest,initialCatalogs:{ja,en:{...en,'nav.home':'Home {unexpected}'}},fetcher:()=>assert.fail('No network fallback for an invalid bundled dictionary')}),/CATALOG_MISMATCH/);
});

test('source and fallback downloads run together even when English arrives first',async()=>{
 let releaseSource;const paths=[];
 const loading=loadCatalogs({manifest,fetcher:url=>{paths.push(url.pathname.split('/').at(-1));return url.pathname.endsWith('ja.json')?new Promise(resolve=>{releaseSource=()=>resolve(Response.json(ja));}):Promise.resolve(Response.json(en));}});
 assert.deepEqual(paths,['ja.json','en.json']);releaseSource();const catalogs=await loading;assert.equal(catalogs.en['nav.home'],'Home');
});
