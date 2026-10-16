/** Capture existing checkbox inputs; never rebuild the text editors around them. */
export function prepareRoomCheckboxPatch(root,before,after){
 const patches=[];
 for(const input of root.querySelectorAll('.block-check[data-block-check-id]')){
  const id=input.dataset.blockCheckId,previous=before.get(id)?.block,next=after.get(id)?.block;
  if(!input.isConnected||input.type!=='checkbox'||previous?.type!=='checklist'||next?.type!=='checklist'||input.checked!==(previous.data?.checked===true))return null;
  patches.push({input,expected:input.checked,checked:next.data?.checked===true});
 }
 return patches;
}
export function applyRoomCheckboxPatch(patches){
 if(!Array.isArray(patches)||patches.some(({input,expected})=>!input.isConnected||input.type!=='checkbox'||input.checked!==expected))return false;
 for(const{input,checked}of patches)input.checked=checked;
 return true;
}
