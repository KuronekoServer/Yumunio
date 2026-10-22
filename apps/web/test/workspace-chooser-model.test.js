import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseWorkspace,readRecentWorkspace,rememberWorkspace,recentWorkspaceKey,workspaceMonogram,workspaceSlugSuggestion} from '../public/workspace-chooser-model.js';

const memory=()=>{const values=new Map();return{values,getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value))};};

test('a single workspace opens automatically and an empty directory stays empty',()=>{
 assert.deepEqual(chooseWorkspace({workspaces:[{id:'studio',name:'Studio',slug:'studio'}]}),{mode:'open',workspace:{id:'studio',name:'Studio',slug:'studio'}});
 assert.deepEqual(chooseWorkspace({workspaces:[]}),{mode:'empty'});
 assert.deepEqual(chooseWorkspace(),{mode:'empty'});
 assert.deepEqual(chooseWorkspace({workspaces:[{id:'bad id'}]}),{mode:'empty'});
});

test('several workspaces open the remembered one and otherwise show the list',()=>{
 const workspaces=[{id:'studio',name:'Studio',slug:'studio'},{id:'lab',name:'Lab',slug:'lab'}];
 assert.deepEqual(chooseWorkspace({workspaces,recentId:'lab'}),{mode:'open',workspace:workspaces[1]});
 assert.deepEqual(chooseWorkspace({workspaces,recentId:''}),{mode:'list'});
 assert.deepEqual(chooseWorkspace({workspaces,recentId:'removed'}),{mode:'list'});
 assert.deepEqual(chooseWorkspace({workspaces,recentId:'bad id'}),{mode:'list'});
});

test('the recent workspace is stored per account and never trusted from malformed values',()=>{
 const storage=memory();
 assert.equal(rememberWorkspace(storage,'account-a','studio'),true);
 assert.equal(storage.values.get(recentWorkspaceKey('account-a')),'studio');
 assert.equal(readRecentWorkspace(storage,'account-a'),'studio');
 assert.equal(readRecentWorkspace(storage,'account-b'),'');
 assert.equal(rememberWorkspace(storage,'account-a','bad id'),false);
 assert.equal(rememberWorkspace(null,'account-a','studio'),false);
 assert.equal(readRecentWorkspace(null,'account-a'),'');
 const broken={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
 assert.equal(readRecentWorkspace(broken,'account-a'),'');
 assert.equal(rememberWorkspace(broken,'account-a','studio'),false);
 storage.setItem(recentWorkspaceKey('account-a'),'{"not":"an id"}');
 assert.equal(readRecentWorkspace(storage,'account-a'),'');
});

test('workspace tiles and slug suggestions stay readable',()=>{
 assert.equal(workspaceMonogram('studio'),'S');
 assert.equal(workspaceMonogram('黒猫ラボ'),'黒');
 assert.equal(workspaceMonogram('  '),'?');
 assert.equal(workspaceMonogram(null),'?');
 assert.equal(workspaceSlugSuggestion('Product Docs'),'product-docs');
 assert.equal(workspaceSlugSuggestion('  --Team  Space--  '),'team-space');
 assert.equal(workspaceSlugSuggestion('黒猫ラボ'),'');
});
