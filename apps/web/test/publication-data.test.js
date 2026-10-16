import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicSnapshot, validatePublicPage, validatePublicationStatus, validatePublicationReview, publicToken, readPublicationJson } from '../public/publication-data.js';
import { renderPublicationBody } from '../public/publication-view.js';
import {createSimpleTable} from '../public/simple-table.js';

const stamp='2026-10-15T00:00:00.000Z',token='a'.repeat(160);
const snapshot=()=>({title:'<script>Literal title</script>',blocks:[{type:'heading',level:2,text:'Heading'},{type:'paragraph',text:'https://example.invalid/<b>literal</b>',children:[{type:'checklist',text:'Aoi & Ren',checked:false}]},{type:'divider'}]});
const status=()=>({revision:4,pageId:'page-A',mode:'snapshot',active:true,needsRepublish:false,sourceVersion:2,currentSourceVersion:2,publishedAt:stamp,publicPath:'/site.html?publication='+token});
const review=()=>({revision:4,pageId:'page-A',mode:'snapshot',sourceVersion:2,snapshot:snapshot(),summary:{blocksIncluded:4,blocksOmitted:3,linkSpansOmitted:1},exclusions:['attachments','structured-links'],reviewDigest:'b'.repeat(64)});

test('public projection accepts only the independent literal snapshot and returns detached values',()=>{
  const source=snapshot(),value=validatePublicSnapshot(source);
  assert.deepEqual(value,source);value.blocks[1].children[0].text='Own change';
  assert.equal(source.blocks[1].children[0].text,'Aoi & Ren');
  const page=validatePublicPage({schemaVersion:1,mode:'snapshot',publishedAt:stamp,...source});
  assert.equal(page.title,'<script>Literal title</script>');
  assert.equal(page.blocks[1].text,'https://example.invalid/<b>literal</b>');
  for(const type of ['paragraph','heading1','heading2','bulleted-list','numbered-list','quote'])assert.equal(validatePublicSnapshot({title:'Page',blocks:[{type,text:''}]}).blocks[0].type,type);
});

test('private payloads, structured links and unknown fields or block types fail closed',()=>{
  const bad=[{...snapshot(),pageId:'secret'},{title:'Page',blocks:[{type:'paragraph',data:{text:'secret'}}]},{title:'Page',blocks:[{type:'paragraph',text:'label',links:[{pageId:'secret'}]}]},{title:'Page',blocks:[{type:'code',text:'secret'}]},{title:'Page',blocks:[{type:'paragraph',text:'hello',checked:true}]},{title:'Page',blocks:[{type:'divider',text:'secret'}]},{title:'Page',blocks:[{type:'heading1',text:'title',level:1}]},{title:'Page',blocks:[{type:'checklist',text:'task',checked:'false'}]}];
  for(const value of bad)assert.throws(()=>validatePublicSnapshot(value),/INVALID_PUBLICATION/);
  assert.throws(()=>validatePublicPage({schemaVersion:1,mode:'snapshot',publishedAt:stamp,...snapshot(),author:'private'}));
});

test('depth, block count, UTF8 byte and text limits are enforced before rendering',()=>{
  let block={type:'paragraph',text:'last'};for(let level=1;level<20;level++)block={type:'paragraph',text:'nested',children:[block]};
  assert.doesNotThrow(()=>validatePublicSnapshot({title:'Page',blocks:[block]}));
  assert.throws(()=>validatePublicSnapshot({title:'Page',blocks:[{type:'paragraph',text:'too deep',children:[block]}]}));
  assert.doesNotThrow(()=>validatePublicSnapshot({title:'Page',blocks:Array.from({length:1000},()=>({type:'divider'}))}));
  assert.throws(()=>validatePublicSnapshot({title:'Page',blocks:Array.from({length:1001},()=>({type:'divider'}))}));
  assert.throws(()=>validatePublicSnapshot({title:'Page',blocks:[{type:'paragraph',text:'あ'.repeat(70000)}]}));
  assert.throws(()=>validatePublicSnapshot({title:'Page',blocks:[{type:'paragraph',text:'x'.repeat(100001)}]}));
});

test('getters and sparse or extended arrays are rejected without reading accessors',()=>{
  let reads=0;const value={title:'Page',blocks:[]};Object.defineProperty(value,'title',{enumerable:true,get(){reads++;return'unsafe';}});
  assert.throws(()=>validatePublicSnapshot(value));assert.equal(reads,0);
  const blocks=[{type:'paragraph',text:'safe'}];Object.defineProperty(blocks,'0',{enumerable:true,get(){reads++;return{type:'paragraph',text:'unsafe'};}});
  assert.throws(()=>validatePublicSnapshot({title:'Page',blocks}));assert.equal(reads,0);
  assert.throws(()=>validatePublicSnapshot({title:'Page',blocks:Array(1)}));
  const extra=[];extra.secret='private';assert.throws(()=>validatePublicSnapshot({title:'Page',blocks:extra}));
});

test('review binds page, digest, nested counts and exclusion values',()=>{
  assert.deepEqual(validatePublicationReview(review(),'page-A'),review());
  for(const change of [{pageId:'page-B'},{reviewDigest:'B'.repeat(64)},{summary:{blocksIncluded:3,blocksOmitted:0,linkSpansOmitted:0}},{summary:{blocksIncluded:4,blocksOmitted:-1,linkSpansOmitted:0}},{exclusions:['private-ids']},{exclusions:['comments','comments']}])assert.throws(()=>validatePublicationReview({...review(),...change},'page-A'));
});

test('public links allow only a same-origin site route and inactive states cannot expose a link',()=>{
  assert.deepEqual(validatePublicationStatus(status(),'page-A'),status());
  assert.equal(publicToken(token),token);
  for(const publicPath of ['https://example.invalid/site.html?publication='+token,'//example.invalid/'+token,'/site.html?publication='+token+'&private=1','/site.html?publication='+token+'#fragment'])assert.throws(()=>validatePublicationStatus({...status(),publicPath},'page-A'));
  for(const value of [{...status(),active:false},{...status(),publicPath:null},{...status(),needsRepublish:true},{...status(),publishedAt:'not-a-date'},{...status(),currentSourceVersion:3},{...status(),sourceVersion:4}])assert.throws(()=>validatePublicationStatus(value,'page-A'));
  assert.equal(validatePublicationStatus({...status(),active:false,needsRepublish:true,publicPath:null,currentSourceVersion:3},'page-A').publicPath,null);
});

test('bounded JSON decoding rejects oversized, invalid UTF8 and non-JSON responses',async()=>{
  assert.deepEqual(await readPublicationJson(new Response(JSON.stringify(snapshot()))),snapshot());
  await assert.rejects(readPublicationJson(new Response('x'.repeat(262145))),/INVALID_PUBLICATION/);
  await assert.rejects(readPublicationJson(new Response(new Uint8Array([0xff]))),/INVALID_PUBLICATION/);
  await assert.rejects(readPublicationJson(new Response('<script>not JSON</script>')),/INVALID_PUBLICATION/);
});

class Element {
  constructor(tag='#fragment'){this.tag=tag;this.children=[];this.attributes={};this.className='';this.classList={add:value=>{this.className+=' '+value;}};this.value='';}
  set textContent(value){this.value=String(value);this.children=[];}
  get textContent(){return this.value+this.children.map(child=>child.textContent).join('');}
  append(...children){this.children.push(...children);}
  setAttribute(key,value){this.attributes[key]=String(value);}
}
const document={createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element(),createTextNode:text=>{const node=new Element('#text');node.textContent=text;return node;}};
test('literal renderer groups numbered items and never creates links or markup from text',()=>{
  const result=renderPublicationBody({title:'Page',blocks:[{type:'numbered-list',text:'<script>literal</script>'},{type:'numbered-list',text:'https://example.invalid/'},{type:'checklist',text:'task',checked:true}]},document,{checked:'完了',unchecked:'未完了'});
  assert.equal(result.children.length,2);assert.equal(result.children[0].tag,'ol');assert.equal(result.children[0].children.length,2);
  assert.equal(result.children[0].children[0].textContent,'<script>literal</script>');
  assert.equal(result.children[0].children[1].textContent,'https://example.invalid/');
  assert.equal(result.children[1].children[0].attributes['aria-label'],'完了');
  const tags=[];const walk=node=>{tags.push(node.tag);node.children.forEach(walk);};walk(result);assert.equal(tags.includes('a'),false);assert.equal(tags.includes('script'),false);
  assert.throws(()=>renderPublicationBody({title:'Page',blocks:[{type:'iframe',text:'secret'}]},document));
});
test('only canonical literal table snapshots can be public and render without markup, links or editor controls',()=>{const data=createSimpleTable({rows:[['Heading','Other'],['<script>secret()</script>','[label](page-id)']],columnAlignments:['left',null]}),source={title:'Table',blocks:[{type:'table',data}]},safe=validatePublicSnapshot(source);assert.deepEqual(safe,source);safe.blocks[0].data.rows[1][0]='detached';assert.equal(data.rows[1][0],'<script>secret()</script>');for(const block of [{type:'table',data:{legacy:'opaque'}},{type:'table',data:{...data,privateId:'hidden'}},{type:'table',data,children:[]},{type:'table',data,text:'extra'}])assert.throws(()=>validatePublicSnapshot({title:'Table',blocks:[block]}));const rendered=renderPublicationBody(source,document),tags=[];const walk=node=>{tags.push(node.tag);node.children.forEach(walk);};walk(rendered);assert.ok(tags.includes('table'));assert.ok(tags.includes('th'));assert.ok(tags.includes('td'));for(const tag of ['script','a','textarea','button'])assert.equal(tags.includes(tag),false);assert.ok(rendered.textContent.includes('<script>secret()</script>'));});
