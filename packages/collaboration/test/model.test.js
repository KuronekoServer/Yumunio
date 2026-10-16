import test from 'node:test';
import assert from 'node:assert/strict';
import { Y, ROOM_LIMITS, createRoomDocument, encodeRoomState, loadRoomDocument, applyRoomUpdate, validateRoomDocument,
  inspectUpdate, inspectStateVector, toBase64, fromBase64, editableRoomKeys } from '../src/index.js';

const fixture = () => ({title:'Shared title',blocks:[
  {id:'text',type:'paragraph',data:{text:'Hello',links:[{start:0,end:5,label:'Hello',pageId:'other'}]}},
  {id:'parent',type:'quote',data:{text:'Parent'},children:[{id:'child',type:'paragraph',data:{text:'Nested'}}]},
  {id:'source',type:'code',data:{text:'Original private export source',purpose:'import-source',language:'markdown'}},
  {id:'future',type:'future-kind',data:{text:'Preserved future content',extra:{a:1}}}
]});
const client=(state,base)=>loadRoomDocument(state,base);
const delta=(doc,vector)=>Y.encodeStateAsUpdate(doc,vector);
const error=code=>value=>value.code===code;
function varuint(value){const bytes=[];do{const byte=value%128;value=Math.floor(value/128);bytes.push(byte+(value?128:0));}while(value);return bytes;}

test('same-epoch concurrent text and title edits converge in either order and duplicate delivery is idempotent',()=>{
  const base=fixture(),initial=createRoomDocument(base),state=encodeRoomState(initial),a=client(state,base),b=client(state,base);
  try {
    const vector=Y.encodeStateVector(a);a.getText('block:text').insert(5,' A');b.getText('block:text').insert(5,' B');b.getText('title').insert(0,'New ');
    const au=delta(a,vector),bu=delta(b,vector),first=applyRoomUpdate(state,au,base),ab=applyRoomUpdate(first.state,bu,first.draft);
    const second=applyRoomUpdate(state,bu,base),ba=applyRoomUpdate(second.state,au,second.draft);
    assert.deepEqual(ab.draft,ba.draft);assert.match(ab.draft.blocks[0].data.text,/ A/);assert.match(ab.draft.blocks[0].data.text,/ B/);
    assert.equal(ab.draft.title,'New Shared title');assert.deepEqual(ab.draft.blocks[0].data.links,[{start:0,end:5,label:'Hello',pageId:'other'}]);
    assert.deepEqual(applyRoomUpdate(ab.state,au,ab.draft).state,ab.state);
    assert.deepEqual(ab.draft.blocks.slice(1),base.blocks.slice(1));
  }finally{initial.destroy();a.destroy();b.destroy();}
});

test('offline edits reconnect with all dependencies while incomplete dependent updates are never acknowledged',()=>{
  const base=fixture(),initial=createRoomDocument(base),state=encodeRoomState(initial),a=client(state,base),b=client(state,base);
  try {
    const initialVector=Y.encodeStateVector(a);a.getText('block:text').insert(0,'offline ');const afterFirst=Y.encodeStateVector(a);
    a.getText('block:text').insert(8,'second ');const dependent=delta(a,afterFirst);
    assert.throws(()=>applyRoomUpdate(state,dependent,base));
    b.getText('block:child').delete(0,1);const remote=applyRoomUpdate(state,delta(b,initialVector),base);
    const merged=applyRoomUpdate(remote.state,delta(a,initialVector),remote.draft);
    assert.equal(merged.draft.blocks[0].data.text,'offline second Hello');
    assert.equal(merged.draft.blocks[1].children[0].data.text,'ested');
  }finally{initial.destroy();a.destroy();b.destroy();}
});

test('stored CRDT text must exactly match canonical Domain draft; candidate edits are permitted only during update application',()=>{
  const base=fixture(),doc=createRoomDocument(base);try {
    const state=encodeRoomState(doc);doc.getText('block:text').insert(0,'Changed ');const changed=encodeRoomState(doc);
    assert.throws(()=>loadRoomDocument(changed,base),error('ROOM_BASELINE_MISMATCH'));
    const inspected=loadRoomDocument(changed,base,{requireBaselineMatch:false});inspected.destroy();
    const derived=applyRoomUpdate(state,changed,base);const loaded=loadRoomDocument(derived.state,derived.draft);loaded.destroy();
  }finally{doc.destroy();}
});

test('readonly import sources, unknown block payloads and structure cannot be modified through CRDT roots or rich values',()=>{
  const base=fixture(),initial=createRoomDocument(base),state=encodeRoomState(initial);
  for(const mutate of [
    doc=>doc.getText('block:source').insert(0,'Tampered'),doc=>doc.getText('block:future').insert(0,'Tampered'),
    doc=>doc.getArray('structure').insert(0,['new-block']),doc=>doc.getText('block:text').insertEmbed(0,{html:'<script>bad</script>'}),
    doc=>doc.getText('block:text').format(0,1,{bold:true})
  ]){const doc=client(state,base);try{mutate(doc);assert.throws(()=>applyRoomUpdate(state,encodeRoomStateUnchecked(doc),base));}finally{doc.destroy();}}
  initial.destroy();
});
const encodeRoomStateUnchecked=doc=>Y.encodeStateAsUpdate(doc);

test('wire grammar caps counts and claimed lengths before Yjs allocation and rejects trailing or truncated encodings',()=>{
  assert.throws(()=>inspectUpdate(new Uint8Array([65])),error('ROOM_TOO_LARGE'));
  const deleted=new Uint8Array([1,1,1,0,1,1,1,120,...varuint(ROOM_LIMITS.logicalLength+1),0]);
  assert.throws(()=>inspectUpdate(deleted),error('ROOM_TOO_LARGE'));
  const structBomb=new Uint8Array([1,...varuint(ROOM_LIMITS.updateStructs+1)]);
  assert.throws(()=>inspectUpdate(structBomb),error('ROOM_TOO_LARGE'));
  assert.throws(()=>inspectUpdate(new Uint8Array(ROOM_LIMITS.updateBytes+1)),error('ROOM_TOO_LARGE'));
  assert.throws(()=>inspectUpdate(new Uint8Array([0,0,1])));
  assert.throws(()=>inspectUpdate(new Uint8Array([1,1])));
  assert.throws(()=>inspectStateVector(new Uint8Array([65])),error('ROOM_TOO_LARGE'));
  assert.throws(()=>inspectStateVector(new Uint8Array([0,0])));
});

test('expanded text, accumulated tombstones, title and binary/base64 boundaries stay bounded',()=>{
  const base=fixture(),doc=createRoomDocument(base),state=encodeRoomState(doc);
  try{
    assert.deepEqual(fromBase64(toBase64(state)),state);assert.throws(()=>fromBase64('AA=A'));assert.throws(()=>fromBase64('AQ==',0));
    doc.getText('title').insert(0,'x'.repeat(241));assert.throws(()=>validateRoomDocument(doc,base));
    assert.throws(()=>createRoomDocument({title:'',blocks:[{id:'a',type:'paragraph',data:{text:'x'.repeat(100001)}}]}),error('ROOM_TOO_LARGE'));
  }finally{doc.destroy();}
});


test('text-only concurrent clients preserve valid outside inline runs, converge and reject rich Yjs formatting',()=>{
 const base=fixture();base.blocks[0].data={text:'Hello World',marks:[{start:0,end:5,styles:['bold']},{start:6,end:11,styles:['italic'],href:'https://example.invalid/'}]};
 const initial=createRoomDocument(base),state=encodeRoomState(initial),a=client(state,base),b=client(state,base);
 try {
  const vector=Y.encodeStateVector(a);a.getText('block:text').insert(5,' A');b.getText('block:text').insert(6,'B ');
  const au=delta(a,vector),bu=delta(b,vector),first=applyRoomUpdate(state,au,base),ab=applyRoomUpdate(first.state,bu,first.draft);
  const second=applyRoomUpdate(state,bu,base),ba=applyRoomUpdate(second.state,au,second.draft);
  assert.deepEqual(ab.draft,ba.draft);assert.deepEqual(ab.draft.blocks[0].data.marks[0],{start:0,end:5,styles:['bold']});
  assert.equal(ab.draft.blocks[0].data.text.slice(ab.draft.blocks[0].data.marks[1].start,ab.draft.blocks[0].data.marks[1].end),'World');
  assert.deepEqual(applyRoomUpdate(ab.state,au,ab.draft).draft,ab.draft);
  const reloaded=loadRoomDocument(ab.state,ab.draft);reloaded.destroy();
  a.getText('block:text').format(0,2,{bold:true});assert.throws(()=>applyRoomUpdate(state,delta(a,vector),base),error('ROOM_CONTENT_UNSUPPORTED'));
  assert.deepEqual(base.blocks[0].data.marks[0],{start:0,end:5,styles:['bold']});
 }finally{initial.destroy();a.destroy();b.destroy();}
});

test('room mutable fields follow supported parent ancestry and exclude every readonly source or unknown subtree',()=>{
 const base={title:'Nested boundaries',blocks:[{id:'ordinary',type:'paragraph',data:{text:'Parent'},children:[{id:'heading-child',type:'heading',data:{text:'Nested heading'}},{id:'check-child',type:'checklist',data:{text:'Nested checklist',checked:false},children:[{id:'leaf',type:'paragraph',data:{text:'Editable leaf'}}]}]},{id:'source-parent',type:'paragraph',data:{text:'Original parent',purpose:'import-source'},children:[{id:'source-child',type:'paragraph',data:{text:'Original child'},children:[{id:'source-grandchild',type:'heading',data:{text:'Original grandchild'}}]}]},{id:'unknown-parent',type:'future-kind',data:{text:'Future parent'},children:[{id:'unknown-child',type:'paragraph',data:{text:'Future owned child'}}]},{id:'heading-parent',type:'heading',data:{text:'Heading text'},children:[{id:'heading-descendant',type:'paragraph',data:{text:'Unsupported child'}}]},{id:'code-parent',type:'code',data:{text:'Code text'},children:[{id:'code-descendant',type:'paragraph',data:{text:'Unsupported code child'}}]}]};
 assert.deepEqual(editableRoomKeys(base),['title','block:ordinary','block:heading-child','block:check-child','block:leaf','block:heading-parent','block:code-parent']);
 const initial=createRoomDocument(base),state=encodeRoomState(initial);try{
  for(const id of ['source-parent','source-child','source-grandchild','unknown-parent','unknown-child','heading-descendant','code-descendant']){const doc=loadRoomDocument(state,base);try{doc.getText('block:'+id).insert(0,'Tampered ');assert.throws(()=>applyRoomUpdate(state,Y.encodeStateAsUpdate(doc),base),error('ROOM_CONTENT_UNSUPPORTED'));}finally{doc.destroy();}}
  const doc=loadRoomDocument(state,base);try{for(const id of ['heading-child','check-child','leaf'])doc.getText('block:'+id).insert(0,'Valid ');const updated=applyRoomUpdate(state,Y.encodeStateAsUpdate(doc),base);assert.match(updated.draft.blocks[0].children[0].data.text,/^Valid /);assert.match(updated.draft.blocks[0].children[1].data.text,/^Valid /);assert.match(updated.draft.blocks[0].children[1].children[0].data.text,/^Valid /);assert.deepEqual(updated.draft.blocks.slice(1),base.blocks.slice(1));}finally{doc.destroy();}
 }finally{initial.destroy();}
});
test('room retains the eight-level editor boundary and still counts readonly descendants toward the resource cap',()=>{
 const root={id:'depth-0',type:'paragraph',data:{text:'0'}};let node=root;for(let depth=1;depth<=8;depth++){node.children=[{id:'depth-'+depth,type:'paragraph',data:{text:String(depth)}}];node=node.children[0];}const base={title:'Depth',blocks:[root]},keys=editableRoomKeys(base);assert.equal(keys.includes('block:depth-7'),true);assert.equal(keys.includes('block:depth-8'),false);const source={title:'Bounded readonly source',blocks:[{id:'source',type:'paragraph',data:{text:'Source',purpose:'import-source'},children:Array.from({length:ROOM_LIMITS.blockCount},(_,index)=>({id:'child-'+index,type:'paragraph',data:{text:''}}))}]};assert.throws(()=>editableRoomKeys(source),error('ROOM_TOO_LARGE'));
});
test('column wrappers preserve their structure while only normal descendant text participates in CRDT',()=>{
 const base={title:'Columns',blocks:[{id:'group',type:'columns',children:[{id:'left',type:'column',children:[{id:'left-text',type:'paragraph',data:{text:'Left'}}]},{id:'right',type:'column',children:[{id:'right-text',type:'paragraph',data:{text:'Right'}}]}]}]};assert.deepEqual(editableRoomKeys(base),['title','block:left-text','block:right-text']);const initial=createRoomDocument(base),state=encodeRoomState(initial),doc=loadRoomDocument(state,base);
 try{doc.getText('block:left-text').insert(4,' edited');const changed=applyRoomUpdate(state,Y.encodeStateAsUpdate(doc),base);assert.equal(changed.draft.blocks[0].children[0].children[0].data.text,'Left edited');assert.deepEqual(changed.draft.blocks[0].children[1],base.blocks[0].children[1]);assert.equal(changed.draft.blocks[0].type,'columns');doc.getText('block:left').insert(0,'Invalid wrapper text');assert.throws(()=>applyRoomUpdate(state,Y.encodeStateAsUpdate(doc),base),error('ROOM_CONTENT_UNSUPPORTED'));}finally{doc.destroy();initial.destroy();}
});
test('CRDT materialization rebases bound person and date mentions and removes an intersected entity as a whole',()=>{
 const base={title:'Mentions',blocks:[{id:'body',type:'paragraph',data:{text:'Hello Jane 2026-10-16',mentions:[{kind:'person',start:6,end:10,accountId:'person',membershipId:'member-person'},{kind:'date',start:11,end:21,date:'2026-10-16'}]}}]},initial=createRoomDocument(base),state=encodeRoomState(initial),doc=loadRoomDocument(state,base);
 try{doc.getText('block:body').insert(0,'New ');const changed=applyRoomUpdate(state,Y.encodeStateAsUpdate(doc),base);assert.deepEqual(changed.draft.blocks[0].data.mentions,[{kind:'person',start:10,end:14,accountId:'person',membershipId:'member-person'},{kind:'date',start:15,end:25,date:'2026-10-16'}]);const next=loadRoomDocument(changed.state,changed.draft);try{next.getText('block:body').delete(11,1);const edited=applyRoomUpdate(changed.state,Y.encodeStateAsUpdate(next),changed.draft);assert.deepEqual(edited.draft.blocks[0].data.mentions,[{kind:'date',start:14,end:24,date:'2026-10-16'}]);}finally{next.destroy();}assert.equal(base.blocks[0].data.mentions[0].start,6);}finally{doc.destroy();initial.destroy();}
});
