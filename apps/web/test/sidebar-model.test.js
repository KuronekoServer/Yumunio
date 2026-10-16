import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarPageRows,revealSidebarPage} from '../public/sidebar-model.js';
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
