const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export function validatePageAppearance(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('INVALID_PAGE_APPEARANCE');
 const keys=['icon','coverAttachmentId','fullWidth','smallText','locked'];
 if(Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key))||typeof value.icon!=='string'||value.icon.length>32||!value.icon.isWellFormed()||/[\u0000-\u001f\u007f]/.test(value.icon)||value.coverAttachmentId!==null&&!id(value.coverAttachmentId)||['fullWidth','smallText','locked'].some(key=>typeof value[key]!=='boolean'))throw new TypeError('INVALID_PAGE_APPEARANCE');
 return {...value};
}
export const defaultPageAppearance=()=>({icon:'',coverAttachmentId:null,fullWidth:false,smallText:false,locked:false});
