import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarPageRows,revealSidebarPage,sidebarSiblings,sidebarSiblingPositions,sidebarAncestors,sidebarDropPlacement,readSidebarDisclosure,writeSidebarDisclosure,sidebarLayoutKey} from '../public/sidebar-model.js';

test('sidebar layout measurements follow tree geometry rather than selection or document edits',()=>{
 const pages=[{id:'a',parentId:null},{id:'b',parentId:null}],model={state:{pages,current:{page:{id:'a'}},draft:{title:'Before'}},pageRows:sidebarPageRows(pages),activeTeams:[{id:'team'}],collapsedTeams:[],expandedPages:[]},before=sidebarLayoutKey(model);
 model.state.current.page.id='b';model.state.draft.title='After';assert.equal(sidebarLayoutKey(model),before);
 model.pageRows=sidebarPageRows(pages.toReversed());assert.notEqual(sidebarLayoutKey(model),before);model.pageRows=sidebarPageRows(pages);
 model.expandedPages=['a'];assert.notEqual(sidebarLayoutKey(model),before);model.expandedPages=[];
 model.collapsedTeams=['team'];assert.notEqual(sidebarLayoutKey(model),before);model.collapsedTeams=[];
 pages[1].favorite=true;assert.notEqual(sidebarLayoutKey(model),before);
});
test('sidebar collapses descendants without synthesizing unreadable ancestors or mixing independent roots',()=>{
 const pages=[{id:'collection',parentId:null},{id:'record',parentId:'collection'},{id:'child',parentId:'record'},{id:'shared',parentId:null},{id:'orphan',parentId:'unreadable'}],expanded=new Set();
 assert.deepEqual(sidebarPageRows(pages,expanded).map(({page,depth,hasChildren})=>[page.id,depth,hasChildren]),[['collection',0,true],['shared',0,false],['orphan',0,false]]);
 expanded.add('collection');assert.deepEqual(sidebarPageRows(pages,expanded).map(row=>row.page.id),['collection','record','shared','orphan']);
 revealSidebarPage(pages,'child',expanded);assert.deepEqual(sidebarPageRows(pages,expanded).map(row=>[row.page.id,row.depth]),[['collection',0],['record',1],['child',2],['shared',0],['orphan',0]]);
 assert.equal(expanded.has('unreadable'),false);
});
test('stale page identities and cycles remain bounded and reveal does not expand unrelated pages',()=>{
 const pages=[{id:'a',parentId:'b'},{id:'b',parentId:'a'},{id:'independent',parentId:null}],expanded=new Set();revealSidebarPage(pages,'missing',expanded);assert.equal(expanded.size,0);revealSidebarPage(pages,'a',expanded);assert.deepEqual(sidebarPageRows(pages,expanded).map(row=>row.page.id),['independent']);assert.equal(expanded.has('independent'),false);
});

test('children stay next to their parent in saved sibling order even when appended after other roots',()=>{
 const pages=[{id:'a',parentId:null},{id:'b',parentId:null},{id:'second',parentId:'a'},{id:'c',parentId:null},{id:'grandchild',parentId:'first'},{id:'first',parentId:'a'}];
 assert.deepEqual(sidebarPageRows(pages,new Set(['a','first'])).map(row=>[row.page.id,row.depth]),[['a',0],['second',1],['first',1],['grandchild',2],['b',0],['c',0]]);
 assert.deepEqual(sidebarSiblingPositions(pages).get('first'),{index:1,count:2});assert.deepEqual(sidebarAncestors(pages,'grandchild').map(page=>page.id),['a','first']);
 assert.deepEqual(sidebarAncestors([{id:'visible',parentId:'hidden'}],'visible'),[]);
});

test('deep page trees use an iterative traversal with real depth and no five-level ceiling',()=>{
 const pages=Array.from({length:12000},(_,i)=>({id:'page-'+i,parentId:i?'page-'+(i-1):null})),expanded=new Set();
 revealSidebarPage(pages,'page-11999',expanded);const rows=sidebarPageRows(pages,expanded);
 assert.equal(rows.length,12000);assert.equal(rows.at(-1).depth,11999);assert.equal(rows.at(-1).page.id,'page-11999');
});

test('drop edges distinguish sibling placement and nesting while refusing cycles, records and inaccessible parents',()=>{
 const page=(id,parentId=null,teamspaceId=null)=>({id,parentId,teamspaceId,capabilities:['read','manage']});
 const pages=[page('a'),page('b'),page('c'),page('child','b'),page('other-team',null,'team')];
 assert.deepEqual(sidebarDropPlacement(pages,'c','b','before'),{parentId:null,beforeId:'b'});
 assert.deepEqual(sidebarDropPlacement(pages,'a','b','after'),{parentId:null,beforeId:'c'});
 assert.deepEqual(sidebarDropPlacement(pages,'a','b','inside'),{parentId:'b',beforeId:null});
 assert.equal(sidebarDropPlacement(pages,'b','child','inside'),null);assert.equal(sidebarDropPlacement(pages,'a','other-team','before'),null);
 pages[1].capabilities=['read'];assert.equal(sidebarDropPlacement(pages,'a','b','inside'),null);
 assert.deepEqual(sidebarSiblings(pages,'a').map(page=>page.id),['a','b','c']);
 pages[0].recordId='row';assert.equal(sidebarDropPlacement(pages,'a','b','before'),null);
});

test('disclosure storage keeps scopes independent and malformed or unavailable storage never breaks navigation',()=>{
 const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 writeSidebarDisclosure(storage,'workspace:actor',new Set(['page']),new Set(['team']));
 assert.deepEqual([...readSidebarDisclosure(storage,'workspace:actor').expanded],['page']);assert.equal(readSidebarDisclosure(storage,'workspace:other'),null);
 storage.setItem('bad','{"version":1,"expanded":["bad id"],"collapsedTeams":[]}');assert.equal(readSidebarDisclosure(storage,'bad'),null);
 assert.equal(readSidebarDisclosure({getItem(){throw Error('unavailable');}},'scope'),null);assert.doesNotThrow(()=>writeSidebarDisclosure({setItem(){throw Error('quota');}},'scope',new Set(),new Set()));
});
