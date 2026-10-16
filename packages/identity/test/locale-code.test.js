import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalLocale,isLocaleTag} from '../src/locale-code.js';
import {validatePreferences} from '../src/preferences-model.js';
const pref={schemaVersion:1,themeId:'light',customColors:{},fontId:'system',locale:'ja'};
test('locale validation canonicalizes language/script/region without depending on packaged catalogs',()=>{for(const[input,expected]of [['ja','ja'],['en-gb','en-GB'],['zh-hans','zh-Hans'],['qaa','qaa']]){assert.equal(canonicalLocale(input),expected);assert.equal(validatePreferences({...pref,locale:input}).locale,expected);}});
test('unsafe and malformed locale tags cannot replace complete preferences',()=>{for(const locale of ['',null,'../en','en_US','en%2Fja','en?secret=1','javascript:alert(1)','x'.repeat(64),' en','en\u0000']){assert.equal(isLocaleTag(locale),false);assert.throws(()=>validatePreferences({...pref,locale}));}assert.equal(pref.locale,'ja');});
