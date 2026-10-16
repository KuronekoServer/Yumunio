import test from 'node:test';
import assert from 'node:assert/strict';
import {PreferencesStore,THEMES} from '../public/preferences.js';
import {resolveAppearancePreferences,applyPreferenceAppearance,watchSystemAppearance} from '../public/appearance.js';
import {validatePreferences} from '../../../packages/identity/src/preferences-model.js';
const snapshot=(patch={})=>({schemaVersion:1,themeId:'ocean',customColors:{accent:'#23558E'},fontId:'system',locale:'ja',...patch});
const storage=()=>{const map=new Map();return{getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),map};};
function display(){
 const values=new Map(),root={style:{setProperty:(key,value)=>values.set(key,value)},dataset:{}},meta={setAttribute:(key,value)=>values.set('meta-'+key,value)};
 const input={value:'Unsaved draft',selectionStart:3,selectionEnd:7};
 return{values,root,input,document:{documentElement:root,querySelector:selector=>{assert.equal(selector,'meta[name="theme-color"]');return meta;}}};
}
function media(){
 const listeners=new Set(),query={matches:false,addEventListener:(type,callback)=>{assert.equal(type,'change');listeners.add(callback);},removeEventListener:(type,callback)=>listeners.delete(callback)};
 return{query,listeners,matchMedia:argument=>{assert.equal(argument,'(prefers-color-scheme: dark)');return query;},emit(dark){query.matches=dark;for(const callback of listeners)callback();}};
}
test('system appearance preserves a manual palette and colors while resolving only presentation',()=>{
 const original=snapshot({followSystem:true}),before=structuredClone(original);
 assert.equal(resolveAppearancePreferences(original,{dark:false}).themeId,'light');
 assert.equal(resolveAppearancePreferences(original,{dark:true}).themeId,'midnight');
 assert.deepEqual(resolveAppearancePreferences(original,{dark:true}).customColors,{});
 assert.deepEqual(original,before);assert.equal(THEMES.length,6);
 const manual=snapshot();assert.deepEqual(resolveAppearancePreferences(manual,{dark:true}),manual);
});
test('browser and server preserve legacy snapshots and reject invalid system flags',()=>{
 const legacy=snapshot();assert.deepEqual(validatePreferences(legacy),legacy);assert.deepEqual(PreferencesStore.prototype.validate(legacy),legacy);
 for(const flag of [true,false]){
  const input=snapshot({followSystem:flag}),expected=flag?input:legacy;
  assert.deepEqual(validatePreferences(input),expected);assert.deepEqual(PreferencesStore.prototype.validate(input),expected);
 }
 for(const followSystem of ['true',1,null,{},[]]){
  assert.throws(()=>validatePreferences(snapshot({followSystem})));
  assert.throws(()=>PreferencesStore.prototype.validate(snapshot({followSystem})));
 }
 let invoked=0;const accessor=snapshot();Object.defineProperty(accessor,'followSystem',{enumerable:true,get(){invoked++;return true;}});
 assert.throws(()=>validatePreferences(accessor));assert.equal(invoked,0);
});
test('system selection is per profile, survives reload and returns to manual on explicit theme selection or reset',()=>{
 const backing=storage(),a=new PreferencesStore({storage:backing,profileId:'a'}),b=new PreferencesStore({storage:backing,profileId:'b'});
 a.update(snapshot({followSystem:true}));assert.equal(new PreferencesStore({storage:backing,profileId:'a'}).snapshot().followSystem,true);assert.equal(b.snapshot().followSystem,undefined);
 a.update({locale:'en'});assert.equal(a.snapshot().followSystem,true);a.update({followSystem:false});assert.equal(a.snapshot().themeId,'ocean');assert.equal(a.snapshot().customColors.accent,'#23558E');
 a.update({followSystem:true});a.update({themeId:'forest',customColors:{}});assert.equal(a.snapshot().followSystem,undefined);
 a.update({followSystem:true});a.update({customColors:{accent:'#99D3AF'}});assert.equal(a.snapshot().followSystem,undefined);
 a.update({followSystem:true});a.reset();assert.equal(a.snapshot().followSystem,undefined);
});
test('an OS event follows the current profile and updates tokens without replacing a draft or writing storage',()=>{
 const fake=display(),os=media(),backing=storage();let current=new PreferencesStore({storage:backing,profileId:'a'});
 current.update({followSystem:true});const persisted=backing.map.get(current.key),input=fake.input,changes=[];
 const stop=watchSystemAppearance(()=>current.snapshot(),{document:fake.document,matchMedia:os.matchMedia,onAppearance:appearance=>changes.push(appearance.kind)});
 os.emit(true);assert.equal(fake.root.style.colorScheme,'dark');assert.equal(fake.values.get('--canvas'),THEMES.find(theme=>theme.id==='midnight').colors.canvas);
 assert.equal(fake.values.get('--on-accent'),fake.values.get('--on'));assert.equal(backing.map.get(current.key),persisted);assert.equal(fake.input,input);assert.deepEqual(input,{value:'Unsaved draft',selectionStart:3,selectionEnd:7});
 current=new PreferencesStore({storage:backing,profileId:'b'});current.update({themeId:'forest'});os.emit(false);assert.deepEqual(changes,['dark']);
 current.update({followSystem:true});os.emit(false);assert.equal(fake.root.style.colorScheme,'light');assert.deepEqual(changes,['dark','light']);stop();assert.equal(os.listeners.size,0);os.emit(true);assert.equal(fake.root.style.colorScheme,'light');
});
test('unsupported OS observation is harmless and custom manual appearance uses the actual canvas contrast',()=>{
 const fake=display();const stop=watchSystemAppearance(()=>snapshot({followSystem:true}),{document:fake.document,matchMedia:()=>{throw Error('unsupported');}});stop();assert.equal(fake.values.size,0);
 const custom=snapshot({themeId:'light',customColors:{canvas:'#111111',text:'#FFFFFF',accent:'#AADDFF'}});
 const result=applyPreferenceAppearance(custom,{document:fake.document,dark:false});assert.equal(result.kind,'dark');assert.equal(fake.root.dataset.appearance,'dark');assert.equal(fake.input.value,'Unsaved draft');
});
