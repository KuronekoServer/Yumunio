const databaseLabels=['intro','name','status','assignee','due','todo','doing','done','first','second','third','summary','details','tableView','boardView'];
const datedLabels=['calendarView','timelineView'];
const tableLabels=['intro','item','value','note','first'];
const isId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fail=()=>{const error=new TypeError('INVALID_PAGE_STARTER');error.code='INVALID_INPUT';throw error;};
function exact(value,keys){
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(key=>!keys.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')))fail();
}

/** A reference-free recipe. Labels are literal localized text; structure and IDs are generated. */
export function validatePageStarter(value){
 exact(value,['type','labels']);if(!['board','table','simple-table'].includes(value.type))fail();
 const dated=value.type!=='simple-table'&&datedLabels.some(key=>Object.hasOwn(value.labels??{},key));
 const keys=value.type==='simple-table'?tableLabels:[...databaseLabels,...(dated?datedLabels:[])];exact(value.labels,keys);
 for(const key of keys){const text=value.labels[key];if(typeof text!=='string'||!text.trim()||text.length>(key==='intro'?500:120)||/[\u0000-\u001f\u007f]/.test(text)||!text.isWellFormed())fail();}
 if(value.type!=='simple-table'&&new Set(['todo','doing','done'].map(key=>value.labels[key])).size!==3)fail();
 return structuredClone(value);
}

/** Used by the server and acknowledgement checks. Each call produces an independent database. */
export function instantiateStructuredPageStarter(value,createId=()=>crypto.randomUUID()){
 const {type,labels:l}=validatePageStarter(value),ids=[],used=new Set();
 const mint=()=>{const id=createId();if(!isId(id)||used.has(id))fail();used.add(id);ids.push(id);return id;};
 const paragraph=text=>({id:mint(),type:'paragraph',data:{text}});
 const blocks=[paragraph(l.intro)];
 if(type==='simple-table'){
  blocks.push({id:mint(),type:'table',data:{format:'simple-table-v1',headerRow:true,columnAlignments:[null,null,null],rows:[[l.item,l.value,l.note],[l.first,'',''],['','',''],['','','']] }},paragraph(''));
  return{blocks,ids};
 }
 const id=mint(),pageId=mint(),status=mint(),assignee=mint(),due=mint();
 const properties=[{id:status,name:l.status,type:'status',options:[l.todo,l.doing,l.done]},{id:assignee,name:l.assignee,type:'person'},{id:due,name:l.due,type:'date'}];
 const view=kind=>({name:l[kind+'View'],type:kind,filters:[],sorts:[],groupBy:kind==='board'?status:null,datePropertyId:['calendar','timeline'].includes(kind)?due:null,endDatePropertyId:kind==='timeline'?due:null});
 const views=['table','board',...(l.calendarView?['calendar','timeline']:[])].map(kind=>({id:mint(),...view(kind)}));
 const records=['first','second','third'].map((key,index)=>({id:mint(),pageId:mint(),title:l[key],values:{[status]:[l.todo,l.doing,l.done][index],[assignee]:null,[due]:null},blocks:[{id:mint(),type:'heading',data:{text:l.summary,level:2}},paragraph(''),{id:mint(),type:'heading',data:{text:l.details,level:2}},paragraph('')]}));
 blocks.push({id:mint(),type:'database',data:{format:'collection-view-v1',collectionId:id,view:view(type),visiblePropertyIds:null}},paragraph(''));
 return{blocks,ids,database:{id,pageId,title:l.name,properties,views,records}};
}

/** IDs in the receipt must describe exactly the generated tree, with no surplus or reuse. */
export function pageStarterFromReceipt(recipe,receipt){
 if(receipt?.type!==recipe?.type||!Array.isArray(receipt.ids)||receipt.ids.length>40)fail();
 exact(receipt,['type','ids']);let index=0;
 const plan=instantiateStructuredPageStarter(recipe,()=>receipt.ids[index++]);if(index!==receipt.ids.length)fail();return plan;
}
