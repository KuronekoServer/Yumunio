import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCreatedPage,validateCreatedPageProjection} from '../public/page-create-result.js';
const submitted={expectedRevision:4,title:'My note',blocks:[{id:'body',type:'paragraph',data:{text:''}}]};
const ack={revision:5,page:{id:'new-page',workspaceId:'studio',title:'My note',parentId:null},document:{pageId:'new-page',workspaceId:'studio',version:1,blocks:submitted.blocks}};
test('page creation accepts the legacy raw acknowledgement and separately confirms projected access and placement',()=>{
 const created=validateCreatedPage(submitted,structuredClone(ack),{workspaceId:'studio'});assert.equal(created.page.id,'new-page');
 const projected=structuredClone(ack);Object.assign(projected.page,{teamspaceId:'team-a',capabilities:['read','editBody','manage']});
 assert.equal(validateCreatedPageProjection(created,projected,{workspaceId:'studio',teamspaceId:'team-a'}),projected);
 projected.page.teamspaceId=null;assert.equal(validateCreatedPageProjection(created,projected,{workspaceId:'studio'}).page.teamspaceId,null);
 for(const change of [value=>{value.page.teamspaceId='other';},value=>{value.page.capabilities=['read'];},value=>{value.page.id='other';}]){const invalid=structuredClone(projected);change(invalid);assert.throws(()=>validateCreatedPageProjection(created,invalid,{workspaceId:'studio'}),/INVALID_CREATE_RESPONSE/);}
});
test('a success for another scope, body or version is an unknown creation outcome',()=>{
 for(const change of [value=>{value.revision=6;},value=>{value.page.workspaceId='other';},value=>{value.document.pageId='other';},value=>{value.document.version=2;},value=>{value.document.blocks=[];},value=>{value.page.title='Different';}]){
  const value=structuredClone(ack);change(value);assert.throws(()=>validateCreatedPage(submitted,value,{workspaceId:'studio',teamspaceId:'team-a'}),error=>error.code==='INVALID_CREATE_RESPONSE'&&error.status===0);
 }
});
