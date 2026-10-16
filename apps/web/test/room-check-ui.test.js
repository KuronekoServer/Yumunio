import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRoomCheckboxPatch,applyRoomCheckboxPatch} from '../public/room-check-ui.js';

const block=(id,checked)=>({block:{id,type:'checklist',data:{text:'Unchanged text '+id,checked,marks:[{type:'bold',start:0,end:3}]}}});
function fixture(){
 const inputs=['one','two'].map(id=>({type:'checkbox',isConnected:true,checked:false,dataset:{blockCheckId:id}}));
 const editor={text:'A text draft with a live selection',selection:[4,10]},children=[editor,...inputs];
 const root={querySelectorAll(selector){assert.equal(selector,'.block-check[data-block-check-id]');return inputs;},replaceChildren(){assert.fail('Remote checkbox updates must not rebuild the body.');}};
 const before=new Map(inputs.map(input=>[input.dataset.blockCheckId,block(input.dataset.blockCheckId,false)])),after=new Map(inputs.map(input=>[input.dataset.blockCheckId,block(input.dataset.blockCheckId,true)]));
 return{root,inputs,editor,children,before,after};
}
test('remote check patches only existing input values and preserves editor identity text and selection',()=>{
 const f=fixture(),editor=f.editor,selection=f.editor.selection,before=structuredClone([...f.before]);
 const patches=prepareRoomCheckboxPatch(f.root,f.before,f.after);assert.equal(patches.length,2);assert.equal(applyRoomCheckboxPatch(patches),true);assert.deepEqual(f.inputs.map(input=>input.checked),[true,true]);
 assert.equal(f.children[0],editor);assert.equal(editor.selection,selection);assert.equal(editor.text,'A text draft with a live selection');assert.deepEqual([...f.before],before);
});
test('a changed or detached input invalidates the entire patch before another checkbox can change',()=>{
 for(const mode of ['changed','detached','type']){const f=fixture(),patches=prepareRoomCheckboxPatch(f.root,f.before,f.after);if(mode==='changed')f.inputs[1].checked=true;else if(mode==='detached')f.inputs[1].isConnected=false;else f.inputs[1].type='text';assert.equal(applyRoomCheckboxPatch(patches),false);assert.equal(f.inputs[0].checked,false);}
});
test('preflight defers mismatching checkbox DOM and foreign or removed canonical blocks without mutating a draft',()=>{
 for(const change of [f=>f.inputs[0].checked=true,f=>f.inputs[0].isConnected=false,f=>f.before.delete('one'),f=>f.after.delete('one'),f=>f.after.get('one').block.type='paragraph']){const f=fixture();change(f);assert.equal(prepareRoomCheckboxPatch(f.root,f.before,f.after),null);assert.equal(f.inputs[1].checked,false);}
});
