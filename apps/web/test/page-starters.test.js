import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateDocument} from '@yumunio/domain';
import {pageStarters,instantiatePageStarter,matchingPageStarters} from '../public/page-starters.js';
import {validatePersonalSnapshot} from '../public/templates-model.js';
import {validateCatalogParity} from '../public/i18n.js';
import {instantiateStructuredPageStarter} from '../public/page-starter.js';

const catalog=async locale=>JSON.parse(await readFile(new URL('../public/workspace-locales/'+locale+'.json',import.meta.url),'utf8'));
test('all localized text, board and table starters produce valid independent documents',async()=>{
  const ja=await catalog('ja'),en=await catalog('en');assert.equal(validateCatalogParity(ja,en).valid,true);
  for(const messages of [ja,en]){
    const rows=pageStarters(key=>{assert.ok(Object.hasOwn(messages,key),key);return messages[key];});
    assert.equal(rows.length,10);assert.equal(new Set(rows.map(row=>row.id)).size,10);
    assert.deepEqual(rows.filter(row=>row.starter).map(row=>row.starter.type),['board','table','simple-table']);
    for(const row of rows){validatePersonalSnapshot(row.snapshot);const a=instantiatePageStarter(row.snapshot),b=instantiatePageStarter(row.snapshot);
      if(row.starter){const first=instantiateStructuredPageStarter(row.starter),second=instantiateStructuredPageStarter(row.starter);validateDocument({workspaceId:'studio',pageId:'page-a',version:1,blocks:first.blocks,updatedAt:'2026-10-20T00:00:00.000Z'});assert.ok(first.ids.every(id=>!second.ids.includes(id)));continue;}
      assert.equal(new Set([...a,...b].map(block=>block.id)).size,a.length+b.length);
      const document=validateDocument({workspaceId:'studio',pageId:'page-a',version:1,blocks:a,updatedAt:'2026-10-20T00:00:00.000Z'});assert.ok(document.blocks.length);
      const original=row.snapshot.blocks[0].data.text;a[0].data.text='Edited';assert.equal(row.snapshot.blocks[0].data.text,original);assert.notEqual(b[0].data.text,'Edited');
    }
    const issue=rows.find(row=>row.id==='starter:issue');assert.equal(issue.snapshot.blocks.at(-1).type,'checklist');assert.equal(issue.snapshot.blocks.at(-1).data.checked,false);
  }
});
test('personal snapshots retain nested formatting, checkbox state and literal text with fresh IDs',()=>{
  const snapshot={title:'<script>literal</script>',blocks:[{type:'toggle',data:{text:'Details'},children:[{type:'paragraph',data:{text:'日本語のメモ',marks:[{start:0,end:3,styles:['bold','italic']}]}},{type:'checklist',data:{text:'Done',checked:true}}]}]};
  const before=structuredClone(snapshot),blocks=instantiatePageStarter(snapshot);assert.deepEqual(snapshot,before);assert.equal(blocks[0].children[1].data.checked,true);assert.deepEqual(blocks[0].children[0].data.marks,snapshot.blocks[0].children[0].data.marks);
  assert.equal(new Set([blocks[0].id,...blocks[0].children.map(block=>block.id)]).size,3);
  blocks[0].children[0].data.marks[0].styles.push('code');assert.deepEqual(snapshot,before);
});
test('unsafe source references and collisions are rejected before page creation',()=>{
  for(const block of [{id:'source',type:'paragraph',data:{text:'x'}},{type:'database',data:{collectionId:'private'}},{type:'paragraph',data:{text:'x',links:[{pageId:'private'}]}},{type:'image',data:{attachmentId:'private'}}])assert.throws(()=>instantiatePageStarter({title:'Unsafe',blocks:[block]}));
  assert.throws(()=>instantiatePageStarter({title:'',blocks:[{type:'paragraph',data:{text:'a'}},{type:'paragraph',data:{text:'b'}}]},()=>'same'),/INVALID_TEMPLATE_BLOCK_ID/);
  assert.equal(instantiatePageStarter({title:'',blocks:[]})[0].type,'paragraph');
});
test('search uses the name and description, normalizes width and case, and combines terms',()=>{
  const rows=[{name:'Task checklist',description:'Small next steps'},{name:'議事録',description:'議題と決定事項'}];
  assert.deepEqual(matchingPageStarters(rows,' ＴＡＳＫ next '),[rows[0]]);assert.deepEqual(matchingPageStarters(rows,'決定'),[rows[1]]);assert.deepEqual(matchingPageStarters(rows,'task 議題'),[]);assert.deepEqual(matchingPageStarters(rows,' '),rows);
});
