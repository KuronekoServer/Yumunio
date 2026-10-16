const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
export const APPFLOWY_NATIVE_LIMITS = Object.freeze({entries:2000,jsonBytes:8*1024*1024,jsonEntryBytes:2*1024*1024,nodes:500000,blocks:20000,pages:1000,depth:8,textChars:100000});
export const APPFLOWY_NATIVE_BUNDLE_LIMITS = Object.freeze({pages:500,requestBytes:768000,assets:100,assetBindings:1000});
export class AppFlowyNativeError extends Error {
  constructor(code, requiredAcknowledgements=[]) {super('The AppFlowy import could not be prepared.');this.name='AppFlowyNativeError';this.code=code;this.requiredAcknowledgements=Object.freeze([...requiredAcknowledgements]);}
}
const fail = (code='INVALID_APPFLOWY_NATIVE') => {throw new AppFlowyNativeError(code);};
const own = (o,k) => Object.hasOwn(o,k);
const record = o => o!==null && typeof o==='object' && !Array.isArray(o);
const identifier = v => typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const text = (v,max=100000) => {if(typeof v!=='string'||v.length>max||v.includes('\0'))fail();return v;};
const nativeId = v => typeof v==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(v);
const sourceId = v => {if(!identifier(v))fail();return v;};
const basename = path => path.slice(path.lastIndexOf('/')+1);
const stem = path => basename(path).replace(/\.json$/i,'');
const clone = o => JSON.parse(JSON.stringify(o));
function pathValue(path) {
  if(typeof path!=='string'||!path||path.length>1024||path!==path.normalize('NFC')||path.startsWith('/')||/[\\:\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(path))fail('UNSAFE_ZIP_PATH');
  const parts=path.split('/');
  if(parts.length>16||parts.some(p=>!p||p==='.'||p==='..'||p.length>255||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))fail('UNSAFE_ZIP_PATH');
  return path;
}
function captureJSON(value, maximum=APPFLOWY_NATIVE_LIMITS.nodes) {
  let nodes=0,chars=0;
  const ancestors=new Set();
  const walk=(item,depth)=>{
    if(++nodes>maximum||depth>64)fail('APPFLOWY_MODEL_LIMIT');
    if(typeof item==='string'){chars+=item.length;if(chars>16*1024*1024)fail('APPFLOWY_MODEL_LIMIT');return;}
    if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
    if(typeof item!=='object'||ancestors.has(item))fail();
    const array=Array.isArray(item), proto=Object.getPrototypeOf(item);
    if(proto!==(array?Array.prototype:Object.prototype)&&!(proto===null&&!array))fail();
    const descriptors=Object.getOwnPropertyDescriptors(item),keys=Reflect.ownKeys(descriptors);
    if(array&&keys.length!==item.length+1)fail();
    ancestors.add(item);
    for(const key of keys){
      if(array&&key==='length')continue;
      const d=descriptors[key];
      if(typeof key!=='string'||!d.enumerable||!own(d,'value')||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))fail();
      walk(d.value,depth+1);
    }
    ancestors.delete(item);
  };
  walk(value,0);return clone(value);
}
function stable(value) {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(record(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function parseJSON(bytes) {
  try{return JSON.parse(decoder.decode(bytes).replace(/^\ufeff/,''));}catch{fail('INVALID_APPFLOWY_JSON');}
}
function manifestShape(o) {
  return record(o)&&typeof o.workspace_id==='string'&&record(o.views)&&record(o.collab_objects)&&Array.isArray(o.dependencies)&&Array.isArray(o.workspace_database_meta)&&Number.isSafeInteger(o.export_timestamp);
}
function metadataShape(o) {
  const e=o?.export_info;
  return record(o)&&Object.keys(o).length===1&&record(e)&&typeof e.workspace_id==='string'&&Number.isSafeInteger(e.export_timestamp)&&typeof e.archive_format==='string'&&typeof e.version==='string';
}
export function isAppFlowyNativeArchive(extractedMap) {
  if(!(extractedMap instanceof Map))return false;
  let metadata=null,manifest=null;
  try{
    for(const [path,bytes]of extractedMap){
      if(typeof path!=='string'||!path.endsWith('.json')||!(bytes instanceof Uint8Array)||bytes.length>APPFLOWY_NATIVE_LIMITS.jsonEntryBytes)continue;
      if(!path.includes('/')&&path==='metadata.json')metadata=parseJSON(bytes);
      else if(!path.includes('/')){const o=parseJSON(bytes);if(manifestShape(o)){if(manifest)return false;manifest=o;}}
    }
    return metadataShape(metadata)&&manifestShape(manifest)&&metadata.export_info.workspace_id===manifest.workspace_id&&metadata.export_info.export_timestamp===manifest.export_timestamp;
  }catch{return false;}
}
const messages=Object.freeze({
  APPFLOWY_NATIVE_SUBSET:'AppFlowyのJSONスナップショットを変換します。元の共有権限・履歴・共同編集状態は復元しません。',
  NATIVE_SELECT_LABELS:'選択項目のIDを表示名へ変換し、元IDを行の参照JSONに保持します。',
  NATIVE_SELECT_UNRESOLVED:'選択項目を一意に解決できないセルは元の文字列のまま保持します。',
  NATIVE_DATABASE_TEXT:'データベースの列は文字列として保持します。型・計算式・ビュー設定は原設定の参照情報で確認してください。',
  NATIVE_UNSUPPORTED_BLOCK:'一部のブロックは読み取り用の参照情報として保持します。',
  NATIVE_UNSUPPORTED_FORMAT:'文字色・背景色など未対応の書式は原文JSONに保持します。',
  NATIVE_UNRESOLVED_LINK:'解決できない参照はリンクとして有効にしません。',
  NATIVE_ASSETS_EXCLUDED:'選択して保存していない添付は取り込まれません。',
  NATIVE_VIEW_REFERENCE:'同じデータベースの追加ビューは参照ページとして保持します。',
  NATIVE_ROW_LOCATION:'レコード本文をデータベース配下に置き、以前の位置には参照ページを残します。',
  NATIVE_HIERARCHY_DETACHED:'元データの自己親参照を外し、ページを取込み先の直下へ置きます。元の親情報は参照JSONに残します。',
  NATIVE_ORPHAN_BLOCK:'ページの子要素から到達できないブロックは原文JSONだけに保持します。',
});
const styles=['bold','italic','strike','underline','code'];
function hrefValue(value) {
  if(typeof value!=='string'||value.length>2048||value!==value.trim()||/[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/.test(value)||!/^https?:\/\//i.test(value))return null;
  try{const u=new URL(value);return !u.username&&!u.password&&u.hostname&&u.href.length<=2048?u.href:null;}catch{return null;}
}
function normalizeDocument(o) {
  const value=captureJSON(o);
  if(!record(value.blocks)||!record(value.meta)||!record(value.meta.children_map)||!nativeId(value.page_id)||!record(value.meta.text_map??{}))fail();
  for(const [key,delta]of Object.entries(value.meta.text_map??{})){
    if(typeof delta==='string'){try{value.meta.text_map[key]=JSON.parse(delta);}catch{fail('INVALID_APPFLOWY_DELTA');}}
    if(!Array.isArray(value.meta.text_map[key]))fail('INVALID_APPFLOWY_DELTA');
  }
  return value;
}
async function rowDocumentId(rowId) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rowId))return null;
  const hex=rowId.replaceAll('-',''), data=new Uint8Array(16+11);
  for(let i=0;i<16;i++)data[i]=parseInt(hex.slice(i*2,i*2+2),16);
  data.set(encoder.encode('document_id'),16);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-1',data));hash[6]=(hash[6]&15)|80;hash[8]=(hash[8]&63)|128;
  const out=Array.from(hash.slice(0,16),v=>v.toString(16).padStart(2,'0')).join('');
  return out.slice(0,8)+'-'+out.slice(8,12)+'-'+out.slice(12,16)+'-'+out.slice(16,20)+'-'+out.slice(20);
}
const compactBlockKeys=['id','ty','parent','children','data'];
function compactDocumentSource(value) {
  if(!record(value.blocks))return null;
  const tuples=[];
  for(const [key,b]of Object.entries(value.blocks)){
    if(!record(b)||compactBlockKeys.some(k=>!own(b,k))||b.id!==key||!nativeId(key)||typeof b.ty!=='string'||typeof b.parent!=='string'||typeof b.children!=='string'||!record(b.data))return null;
    tuples.push([key,b.ty,b.parent,b.children,b.data,Object.fromEntries(Object.entries(b).filter(([k])=>!compactBlockKeys.includes(k)))]);
  }
  return {...value,blocks:tuples};
}
function validateCompactSource(data) {
  if(data.sourceEncoding===undefined)return;
  if(data.sourceEncoding!=='appflowy-document-tuples-v1'||data.sourceFormat!=='appflowy-document-v1'||data.purpose!=='import-source'||!record(data.source)||!Array.isArray(data.source.blocks)||data.source.blocks.length>APPFLOWY_NATIVE_LIMITS.blocks)fail();
  const ids=new Set();
  for(const tuple of data.source.blocks){
    if(!Array.isArray(tuple)||tuple.length!==6||!nativeId(tuple[0])||ids.has(tuple[0])||typeof tuple[1]!=='string'||typeof tuple[2]!=='string'||typeof tuple[3]!=='string'||!record(tuple[4])||!record(tuple[5])||Object.keys(tuple[5]).some(k=>compactBlockKeys.includes(k)))fail();
    ids.add(tuple[0]);
  }
}
function sourceBlocks(value,prefix,kind) {
  const compact=kind==='appflowy-document-v1'?compactDocumentSource(value):null;
  return [{id:prefix+'-source-1',type:'code',data:{text:'',source:clone(compact??value),...(compact?{sourceEncoding:'appflowy-document-tuples-v1'}:{}),language:'json',purpose:'import-source',sourceFormat:kind}}];
}
function selectionNames(field) {
  if(![3,4].includes(field.field_type))return null;
  const content=field.type_options?.[String(field.field_type)]?.content;
  if(typeof content!=='string'||content.length>100000)return null;
  let optionData;
  try{optionData=JSON.parse(content);}catch{return null;}
  if(!record(optionData)||!Array.isArray(optionData.options)||optionData.options.length>1000)return null;
  const names=new Map();
  for(const option of optionData.options){
    if(!record(option)||!nativeId(option.id)||names.has(option.id)||typeof option.name!=='string'||!option.name||option.name.length>100000||option.name.includes('\0'))return null;
    names.set(option.id,option.name);
  }
  return names;
}
function selectionText(field,cell,names,warn) {
  const raw=cell.data;
  if(![3,4].includes(field.field_type)||raw==='')return raw;
  if(cell.field_type!==field.field_type||!names){warn('NATIVE_SELECT_UNRESOLVED');return raw;}
  const selected=raw.split(',');
  if(selected.length>1000||field.field_type===3&&selected.length!==1||selected.some(id=>!id||!names.has(id))){
    warn('NATIVE_SELECT_UNRESOLVED');return raw;
  }
  const label=selected.map(id=>names.get(id)).join(', ');
  if(label.length>100000){warn('NATIVE_SELECT_UNRESOLVED');return raw;}
  warn('NATIVE_SELECT_LABELS');return label;
}
function exactObject(value,required,optional=[]) {
  if(!record(value)||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k))||required.some(k=>!own(value,k)))fail();
}
function warningRows(counts) {return [...counts].map(([code,count])=>({code,count,message:messages[code]??'元のデータは変換範囲を確認してください。'}));}
/** Parse JSON snapshots only. Binary collab state, accounts and permissions are never replayed. */
export async function parseAppFlowyNative(extractedMap, options={}) {
  if(!(extractedMap instanceof Map)||extractedMap.size>APPFLOWY_NATIVE_LIMITS.entries)fail();
  const opts=captureJSON(options);
  exactObject(opts,[],['entries','archiveBytes','uncompressedBytes']);
  if(!isAppFlowyNativeArchive(extractedMap))fail('APPFLOWY_NATIVE_METADATA_REQUIRED');
  const parsed=new Map();let jsonBytes=0;
  for(const [path,bytes]of extractedMap){
    pathValue(path);if(!(bytes instanceof Uint8Array))fail();
    if(!path.toLowerCase().endsWith('.json'))continue;
    if(bytes.length>APPFLOWY_NATIVE_LIMITS.jsonEntryBytes||(jsonBytes+=bytes.length)>APPFLOWY_NATIVE_LIMITS.jsonBytes)fail('APPFLOWY_JSON_LIMIT');
    parsed.set(path,captureJSON(parseJSON(bytes)));
  }
  const inputEntries=opts.entries??[...extractedMap].map(([path,bytes],i)=>({id:'entry-'+(i+1),path,bytes:bytes.length}));
  if(!Array.isArray(inputEntries)||inputEntries.length>APPFLOWY_NATIVE_LIMITS.entries)fail('APPFLOWY_MODEL_LIMIT');
  const entryPaths=new Set(),entryIds=new Set();
  const entries=inputEntries.map(row=>{
    exactObject(row,['id','path','bytes']);sourceId(row.id);pathValue(row.path);
    if(!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>16*1024*1024||entryPaths.has(row.path.toLowerCase())||entryIds.has(row.id))fail();
    entryPaths.add(row.path.toLowerCase());entryIds.add(row.id);
    return {...row,kind:'unsupported'};
  });
  for(const path of parsed.keys())if(!entryPaths.has(path.toLowerCase()))fail();
  const totalBytes=entries.reduce((n,e)=>n+e.bytes,0);
  if(totalBytes>64*1024*1024||opts.archiveBytes!==undefined&&(!Number.isSafeInteger(opts.archiveBytes)||opts.archiveBytes<0||opts.archiveBytes>64*1024*1024)||opts.uncompressedBytes!==undefined&&opts.uncompressedBytes!==totalBytes)fail('APPFLOWY_MODEL_LIMIT');
  const byPath=new Map(entries.map(e=>[e.path,e]));
  const metadata=parsed.get('metadata.json'), manifests=[...parsed].filter(([path,o])=>!path.includes('/')&&manifestShape(o));
  if(manifests.length!==1||!metadataShape(metadata))fail();
  const manifest=manifests[0][1];sourceId(manifest.workspace_id);
  const documents=new Map(),databases=new Map(),counts=new Map([['APPFLOWY_NATIVE_SUBSET',1]]);
  const warn=(code,n=1)=>counts.set(code,(counts.get(code)??0)+n);
  const insert=(map,key,value,entry)=>{
    sourceId(key);
    const canonical=stable(value),old=map.get(key);
    if(old&&old.canonical!==canonical)fail('APPFLOWY_DUPLICATE_ID_CONFLICT');
    if(!old)map.set(key,{value,entry,canonical});
    entry.kind=map===documents?'page':'collection';
  };
  for(const [path,o]of parsed){
    if(record(o)&&own(o,'page_id')&&own(o,'blocks')&&own(o,'meta')){
      if(!/(?:^|\/)documents\/[^/]+\.json$|(?:^|\/)databases\/[^/]+\/[^/]+\/[^/]+\.json$/.test(path))fail();
      insert(documents,stem(path),normalizeDocument(o),byPath.get(path));
    }else if(record(o)&&own(o,'database_id')&&own(o,'fields')&&own(o,'rows')&&own(o,'views')){
      if(!/(?:^|\/)databases\/[^/]+\.json$/.test(path))fail();
      insert(databases,o.database_id,o,byPath.get(path));
    }
  }
  if(!documents.size&&!databases.size)fail('APPFLOWY_NATIVE_CONTENT_REQUIRED');
  const pages=[],collections=[],links=[],assetByBasename=new Map(),assetDeps=new Map(),objects=new Map(),dbPages=new Map(),viewPage=new Map(),objectPage=new Map();
  for(const e of entries)if(!/\.json$|\.collab$/i.test(e.path)){
    e.kind='unsupported';
    if(!/\.(?:html?|zip|db|sqlite3?|sql|exe|dll|bat|cmd|ps1|js)$/i.test(e.path)){const base=basename(e.path);assetByBasename.set(base,assetByBasename.has(base)?null:e);}
  }
  for(const [id,v]of Object.entries(manifest.views)){
    sourceId(id);if(!record(v)||v.view_id!==id||!identifier(v.collab_object_id)||typeof v.name!=='string'||v.name.length>240||typeof v.parent_id!=='string'||!Array.isArray(v.children))fail();
    if(v.parent_id&&v.parent_id!==manifest.workspace_id&&!own(manifest.views,v.parent_id))fail('APPFLOWY_INVALID_HIERARCHY');
    if(v.parent_id===id){warn('NATIVE_HIERARCHY_DETACHED');}
    const chain=new Set([id]);let parent=v.parent_id===id?null:v.parent_id;
    while(parent&&parent!==manifest.workspace_id){if(chain.has(parent)||chain.size>64)fail('APPFLOWY_INVALID_HIERARCHY');chain.add(parent);const nextParent=manifest.views[parent]?.parent_id;parent=nextParent===parent?null:nextParent;}
    const page={id:'af-page-'+(pages.length+1),entryId:(documents.get(v.collab_object_id)??databases.get(v.collab_object_id))?.entry.id??byPath.get(manifests[0][0]).id,title:v.name,parentCandidateId:null,blocks:[],sourceObjectId:v.collab_object_id};
    pages.push(page);viewPage.set(id,page);objects.set(id,v);
    if(documents.has(v.collab_object_id)){
      if(objectPage.has(v.collab_object_id))fail('APPFLOWY_DUPLICATE_VIEW');
      objectPage.set(v.collab_object_id,page);
    }else if(databases.has(v.collab_object_id)){
      if(!dbPages.has(v.collab_object_id))dbPages.set(v.collab_object_id,[]);
      dbPages.get(v.collab_object_id).push(page);
    }else fail('APPFLOWY_MISSING_OBJECT');
  }
  for(const [id,v]of objects)viewPage.get(id).parentCandidateId=v.parent_id===id?null:viewPage.get(v.parent_id)?.id??null;
  for(const [id,doc]of documents)if(!objectPage.has(id)){
    const page={id:'af-page-'+(pages.length+1),entryId:doc.entry.id,title:'',parentCandidateId:null,blocks:[],sourceObjectId:id};
    pages.push(page);objectPage.set(id,page);
  }
  for(const [id,db]of databases)if(!dbPages.has(id)){
    const page={id:'af-page-'+(pages.length+1),entryId:db.entry.id,title:'',parentCandidateId:null,blocks:[],sourceObjectId:id};
    pages.push(page);dbPages.set(id,[page]);
  }
  for(const dep of manifest.dependencies){
    if(!record(dep)||typeof dep.dependency_type!=='string')fail();
    if(dep.dependency_type==='FileAttachment'){
      const asset=assetByBasename.get(dep.target_view_id);
      if(asset&&objectPage.has(dep.source_view_id)){asset.kind='attachment';if(!assetDeps.has(dep.source_view_id))assetDeps.set(dep.source_view_id,new Map());assetDeps.get(dep.source_view_id).set(dep.target_view_id,asset);}
    }
  }
  const reference=(href,attributes,pageObjectId)=>{
    const mention=attributes?.mention;
    const target=record(mention)&&typeof mention.page_id==='string'?mention.page_id:attributes?.is_page_link===true&&typeof href==='string'?href:null;
    if(target){const p=viewPage.get(target)??objectPage.get(target);if(p)return{sourcePageId:p.id};warn('NATIVE_UNRESOLVED_LINK');return null;}
    if(typeof href==='string'&&!/^[a-z][a-z0-9+.-]*:/i.test(href)&&!href.includes('?')&&!href.includes('#')){
      const asset=assetDeps.get(pageObjectId)?.get(basename(href));
      if(asset)return{sourceAssetId:asset.id};
    }
    return null;
  };
  let blockTotal=0;
  const convertDocument=(o,pageObjectId)=>{
    const used=new Set(),all=new Set(),meta=o.meta,blocks=o.blocks;
    const graphColors=new Map();
    const checkGraph=(id,depth)=>{
      if(graphColors.get(id)===1||depth>64)fail('APPFLOWY_INVALID_BLOCK_TREE');
      if(graphColors.get(id)===2)return;
      const b=blocks[id];
      if(!record(b)||b.id!==id||!nativeId(id)||typeof b.children!=='string'||!Array.isArray(meta.children_map[b.children]))fail('APPFLOWY_INVALID_BLOCK_TREE');
      graphColors.set(id,1);
      for(const cid of meta.children_map[b.children]){if(typeof cid!=='string'||blocks[cid]?.parent!==id)fail('APPFLOWY_INVALID_BLOCK_TREE');checkGraph(cid,depth+1);}
      graphColors.set(id,2);
    };
    for(const id of Object.keys(blocks))checkGraph(id,0);
    const visit=(id,ancestor,depth)=>{
      if(depth>APPFLOWY_NATIVE_LIMITS.depth||ancestor.has(id)||used.has(id)||++blockTotal>APPFLOWY_NATIVE_LIMITS.blocks)fail('APPFLOWY_INVALID_BLOCK_TREE');
      const b=blocks[id];if(!record(b)||b.id!==id||!nativeId(id)||typeof b.ty!=='string'||!identifier(b.ty)||typeof b.children!=='string'||!record(b.data))fail();
      used.add(id);const nextAnc=new Set([...ancestor,id]),childIds=meta.children_map[b.children];
      if(!Array.isArray(childIds)||childIds.some(cid=>typeof cid!=='string'||!record(blocks[cid])||blocks[cid].parent!==id))fail('APPFLOWY_INVALID_BLOCK_TREE');
      const out={id:'af-block-'+used.size,type:'paragraph',data:{text:''}},marks=[],refs=[];
      if(b.external_type==='text'&&!own(meta.text_map??{},b.external_id)&&['paragraph','heading','bulleted_list','numbered_list','todo_list','quote','code'].includes(b.ty))fail('INVALID_APPFLOWY_DELTA');
      const ops=meta.text_map?.[b.external_id]??[];
      if(!Array.isArray(ops))fail('INVALID_APPFLOWY_DELTA');
      for(const op of ops){
        if(!record(op)||typeof op.insert!=='string'||Object.keys(op).some(k=>!['insert','attributes'].includes(k))||own(op,'attributes')&&!record(op.attributes))fail('INVALID_APPFLOWY_DELTA');
        const start=out.data.text.length;out.data.text+=op.insert;const end=out.data.text.length;if(end>100000||out.data.text.includes('\0'))fail('APPFLOWY_TEXT_LIMIT');
        const attrs=op.attributes??{},runStyles=styles.filter(s=>attrs[s]===true),ref=reference(attrs.href,attrs,pageObjectId),href=ref||attrs.is_page_link===true||record(attrs.mention)?null:hrefValue(attrs.href);
        if(end>start&&(runStyles.length||href))marks.push({start,end,styles:runStyles,...(href?{href}: {})});
        if(ref&&end>start)refs.push({start,end,label:op.insert,...ref});
        if(Object.keys(attrs).some(k=>!styles.includes(k)&&!['href','mention','is_page_link'].includes(k)))warn('NATIVE_UNSUPPORTED_FORMAT');
      }
      const known={paragraph:'paragraph',heading:'heading',bulleted_list:'bulleted-list',numbered_list:'numbered-list',todo_list:'checklist',quote:'quote',code:'code',divider:'divider'};
      out.type=known[b.ty]??'appflowy-'+b.ty;
      if(b.ty==='heading'){out.data.level=Number.isInteger(b.data.level)?Math.max(1,Math.min(3,b.data.level)):1;if(b.data.level>3)warn('NATIVE_UNSUPPORTED_FORMAT');}
      if(b.ty==='todo_list')out.data.checked=b.data.checked===true;
      if(b.ty==='numbered_list')out.data.start=Number.isSafeInteger(b.data.number)&&b.data.number>0?b.data.number:1;
      if(b.ty==='code'&&typeof b.data.language==='string')out.data.language=b.data.language.slice(0,100);
      if(b.ty==='image'||b.ty==='file'){
        const asset=typeof b.data.url==='string'?assetDeps.get(pageObjectId)?.get(basename(b.data.url)):null;
        if(asset){out.type='paragraph';out.data.text=typeof b.data.name==='string'&&b.data.name?b.data.name:basename(asset.path);refs.length=0;refs.push({start:0,end:out.data.text.length,label:out.data.text,sourceAssetId:asset.id});marks.length=0;}
      }
      if(!known[b.ty]&&out.type!=='paragraph')warn('NATIVE_UNSUPPORTED_BLOCK');
      if(marks.length&&['paragraph','heading','checklist','bulleted-list','numbered-list','quote'].includes(out.type))out.data.marks=marks;
      else if(marks.length)warn('NATIVE_UNSUPPORTED_FORMAT',marks.length);
      if(refs.length&&out.type!=='code')out.data.links=refs;
      const children=childIds.map(cid=>visit(cid,nextAnc,depth+1));if(children.length)out.children=children;
      return out;
    };
    const root=blocks[o.page_id];if(!record(root)||root.ty!=='page'||root.id!==o.page_id||root.parent!=='')fail('APPFLOWY_INVALID_BLOCK_TREE');
    const rootChildren=meta.children_map[root.children];if(!Array.isArray(rootChildren))fail('APPFLOWY_INVALID_BLOCK_TREE');
    used.add(o.page_id);
    const result=rootChildren.map(id=>{if(blocks[id]?.parent!==o.page_id)fail('APPFLOWY_INVALID_BLOCK_TREE');return visit(id,new Set([o.page_id]),1);});
    for(const id of Object.keys(blocks)){all.add(id);if(!nativeId(id))fail();}
    if(used.size<all.size)warn('NATIVE_ORPHAN_BLOCK',all.size-used.size);
    return result;
  };
  for(const [id,doc]of documents){const page=objectPage.get(id);page.blocks=convertDocument(doc.value,id);page.blocks.push(...sourceBlocks({...doc.value,source_parent_id:manifest.views[id]?.parent_id??null},page.id,'appflowy-document-v1'));}
  const boundRows=new Set();
  for(const [dbId,db]of databases){
    const raw=db.value;if(!Array.isArray(raw.fields)||raw.fields.length>128||!Array.isArray(raw.rows)||raw.rows.length>10000||!Array.isArray(raw.views))fail();
    const container=dbPages.get(dbId)[0],fieldIds=new Set();
    const columns=raw.fields.map((f,i)=>{
      if(!record(f)||!nativeId(f.id)||fieldIds.has(f.id)||typeof f.name!=='string'||f.name.length>100000||!Number.isInteger(f.field_type)||f.field_type<0||f.field_type>255)fail();
      fieldIds.add(f.id);return{id:'column-'+(i+1),name:f.name.slice(0,128)||'Column '+(i+1),sourceName:f.name,type:'text',sourceFieldType:f.field_type};
    });
    const collection={id:'af-collection-'+(collections.length+1),entryId:db.entry.id,title:container.title,pageId:container.id,columns,rows:[]};
    const rowIds=new Set(),primaryIndex=raw.fields.findIndex(f=>f.is_primary===true),selectNames=raw.fields.map(selectionNames);
    for(const row of raw.rows){
      if(!record(row)||!identifier(row.id)||row.database_id!==dbId||rowIds.has(row.id)||boundRows.has(row.id)||!record(row.cells))fail('APPFLOWY_INVALID_DATABASE');
      rowIds.add(row.id);boundRows.add(row.id);
      const docId=await rowDocumentId(row.id);let page=docId?objectPage.get(docId):null;
      if(!page){page={id:'af-page-'+(pages.length+1),entryId:db.entry.id,title:'',parentCandidateId:container.id,blocks:[],sourceObjectId:row.id};pages.push(page);}
      if(page.parentCandidateId!==null&&page.parentCandidateId!==container.id){
        const alias={id:'af-page-'+(pages.length+1),entryId:page.entryId,title:page.title,parentCandidateId:page.parentCandidateId,sourceObjectId:page.sourceObjectId,blocks:[{id:'af-alias-1',type:'paragraph',data:{text:page.title||'Record',links:[{start:0,end:(page.title||'Record').length,label:page.title||'Record',sourcePageId:page.id}]}}]};pages.push(alias);warn('NATIVE_ROW_LOCATION');
      }
      page.parentCandidateId=container.id;
      const cells=raw.fields.map((f,fieldIndex)=>{
        const cell=row.cells[f.id];if(cell===undefined)return '';
        if(!record(cell)||typeof cell.data!=='string'||cell.data.length>100000)fail('APPFLOWY_INVALID_DATABASE');
        return selectionText(f,cell,selectNames[fieldIndex],warn);
      });
      if(!page.title&&primaryIndex>=0)page.title=cells[primaryIndex].slice(0,240);
      page.blocks.push(...sourceBlocks({format:'appflowy-row-v1',cells:row.cells},page.id+'-row','appflowy-row-v1'));
      collection.rows.push({id:'af-row-'+(collection.rows.length+1),pageId:page.id,cells});
    }
    container.blocks.push(...sourceBlocks({format:'appflowy-database-v1',fields:raw.fields,views:raw.views.map(v=>{const {row_orders,...rest}=v;return rest;})},container.id,'appflowy-database-v1'));
    for(const alias of dbPages.get(dbId).slice(1)){const label=container.title||'Database';alias.blocks=[{id:'af-database-reference',type:'paragraph',data:{text:label,links:[{start:0,end:label.length,label,sourcePageId:container.id}]}}];warn('NATIVE_VIEW_REFERENCE');}
    collections.push(collection);
  }
  if(pages.length>APPFLOWY_NATIVE_LIMITS.pages)fail('APPFLOWY_MODEL_LIMIT');
  const pageIds=new Set(pages.map(p=>p.id));
  for(const p of pages)if(p.parentCandidateId!==null&&!pageIds.has(p.parentCandidateId))fail('APPFLOWY_INVALID_HIERARCHY');
  let linkCount=0;
  for(const p of pages){const visit=bs=>{for(const b of bs){for(const ref of b.data?.links??[]){links.push({id:'af-link-'+(++linkCount),sourceId:p.id,blockId:b.id,...ref,kind:ref.sourceAssetId?'attachment':'page',targetId:ref.sourceAssetId??ref.sourcePageId});}if(b.children)visit(b.children);}};visit(p.blocks);}
  if(collections.length)warn('NATIVE_DATABASE_TEXT',collections.length);
  const unsupported=entries.filter(e=>e.kind==='unsupported').map(e=>({entryId:e.id,reason:/\.collab$/i.test(e.path)?'BINARY_COLLAB_NOT_REPLAYED':'NATIVE_METADATA_ONLY'}));
  const summary={entries:entries.length,pages:pages.length,collections:collections.length,records:collections.reduce((n,c)=>n+c.rows.length,0),attachments:entries.filter(e=>e.kind==='attachment').length,links:links.length,unresolvedLinks:counts.get('NATIVE_UNRESOLVED_LINK')??0,matchingCandidates:0,unsupported:unsupported.length,archiveBytes:opts.archiveBytes??0,uncompressedBytes:opts.uncompressedBytes??entries.reduce((n,e)=>n+e.bytes,0)};
  return{schemaVersion:2,source:'appflowy-native',summary,warnings:warningRows(counts),entries,pages,collections,links,matches:[],unsupported};
}
function validateBlocks(blocks,refs,pageIds,assetIds) {
  if(!Array.isArray(blocks))fail();const ids=new Set();let count=0;
  const visit=(items,depth)=>{
    if(depth>APPFLOWY_NATIVE_LIMITS.depth)fail('APPFLOWY_INVALID_BLOCK_TREE');
    for(const b of items){
      if(++count>APPFLOWY_NATIVE_LIMITS.blocks)fail('APPFLOWY_MODEL_LIMIT');
      exactObject(b,['id','type','data'],['children']);sourceId(b.id);sourceId(b.type);if(ids.has(b.id))fail();ids.add(b.id);
      if(!record(b.data))fail();validateCompactSource(b.data);const value=b.data.text??'';text(value);
      for(const [key,runs]of [['marks',b.data.marks],['links',b.data.links]]){
        if(runs===undefined)continue;if(!Array.isArray(runs)||runs.length>1000)fail();let previous=0;
        if(key==='marks'&&(!['paragraph','heading','heading1','heading2','checklist','bulleted-list','numbered-list','quote'].includes(b.type)||b.data.purpose==='import-source'))fail();
        for(const run of runs){
          if(!record(run)||!Number.isSafeInteger(run.start)||!Number.isSafeInteger(run.end)||run.start<previous||run.end<=run.start||run.end>value.length||/[\ud800-\udbff]/.test(value[run.start-1]??'')&&/[\udc00-\udfff]/.test(value[run.start]??'')||/[\ud800-\udbff]/.test(value[run.end-1]??'')&&/[\udc00-\udfff]/.test(value[run.end]??''))fail();
          previous=run.end;
          if(key==='marks'){
            exactObject(run,['start','end','styles'],['href']);
            if(!Array.isArray(run.styles)||run.styles.some((s,i)=>!styles.includes(s)||i&&styles.indexOf(s)<=styles.indexOf(run.styles[i-1]))||!run.styles.length&&!own(run,'href')||own(run,'href')&&!hrefValue(run.href))fail();
          }else{
            exactObject(run,['start','end','label'],['sourcePageId','sourceAssetId']);if(value.slice(run.start,run.end)!==run.label)fail();
            const targets=['sourcePageId','sourceAssetId'].filter(k=>own(run,k));if(targets.length!==1)fail();const k=targets[0];
            if(!(k==='sourcePageId'?pageIds:assetIds).has(run[k]))fail();refs.push(run);
          }
        }
      }
      if(b.children!==undefined){if(!Array.isArray(b.children))fail();visit(b.children,depth+1);}
    }
  };visit(blocks,1);return count;
}
function validatedPlan(value) {
  const plan=captureJSON(value);exactObject(plan,['schemaVersion','source','summary','warnings','entries','pages','collections','links','matches','unsupported']);
  if(plan.schemaVersion!==2||plan.source!=='appflowy-native'||!Array.isArray(plan.pages)||plan.pages.length>1000||!Array.isArray(plan.entries)||plan.entries.length>2000||!Array.isArray(plan.collections)||plan.collections.length>128)fail();
  const pageIds=new Set(),entryIds=new Set(),assetIds=new Set(),paths=new Set();
  for(const e of plan.entries){exactObject(e,['id','path','kind','bytes']);sourceId(e.id);pathValue(e.path);if(entryIds.has(e.id)||paths.has(e.path.toLowerCase())||!['page','collection','attachment','unsupported'].includes(e.kind)||!Number.isSafeInteger(e.bytes)||e.bytes<0||e.bytes>16777216)fail();entryIds.add(e.id);paths.add(e.path.toLowerCase());if(e.kind==='attachment')assetIds.add(e.id);}
  for(const p of plan.pages){exactObject(p,['id','entryId','title','parentCandidateId','blocks','sourceObjectId']);sourceId(p.id);sourceId(p.sourceObjectId);text(p.title,240);if(pageIds.has(p.id)||!entryIds.has(p.entryId))fail();pageIds.add(p.id);}
  let blocks=0;const refs=[];
  for(const p of plan.pages){
    if(p.parentCandidateId!==null&&!pageIds.has(p.parentCandidateId))fail();
    const ancestors=new Set([p.id]);let parent=p.parentCandidateId;while(parent!==null){if(ancestors.has(parent)||ancestors.size>64)fail();ancestors.add(parent);parent=plan.pages.find(v=>v.id===parent).parentCandidateId;}
    blocks+=validateBlocks(p.blocks,refs,pageIds,assetIds);
  }
  if(blocks>20000)fail('APPFLOWY_MODEL_LIMIT');
  const boundPages=new Set(),collectionIds=new Set();
  for(const c of plan.collections){
    exactObject(c,['id','entryId','title','pageId','columns','rows']);sourceId(c.id);text(c.title,240);if(collectionIds.has(c.id)||!pageIds.has(c.pageId)||!entryIds.has(c.entryId)||!Array.isArray(c.columns)||c.columns.length>128||!Array.isArray(c.rows)||c.rows.length>10000)fail();collectionIds.add(c.id);
    const columns=new Set();
    for(const col of c.columns){exactObject(col,['id','name','sourceName','type','sourceFieldType']);sourceId(col.id);text(col.name,128);text(col.sourceName,100000);if(columns.has(col.id)||col.type!=='text'||!Number.isInteger(col.sourceFieldType)||col.sourceFieldType<0||col.sourceFieldType>255)fail();columns.add(col.id);}
    const rowIds=new Set();
    for(const row of c.rows){exactObject(row,['id','pageId','cells']);sourceId(row.id);if(rowIds.has(row.id)||boundPages.has(row.pageId)||!pageIds.has(row.pageId)||plan.pages.find(p=>p.id===row.pageId).parentCandidateId!==c.pageId||!Array.isArray(row.cells)||row.cells.length!==c.columns.length)fail();rowIds.add(row.id);boundPages.add(row.pageId);row.cells.forEach(v=>text(v));}
  }
  exactObject(plan.summary,['entries','pages','collections','records','attachments','links','unresolvedLinks','matchingCandidates','unsupported','archiveBytes','uncompressedBytes']);
  if(!Array.isArray(plan.warnings)||plan.warnings.length>Object.keys(messages).length||!Array.isArray(plan.links)||!Array.isArray(plan.matches)||plan.matches.length||!Array.isArray(plan.unsupported))fail();
  const warningCodes=new Set();
  for(const w of plan.warnings){exactObject(w,['code','count','message']);if(!own(messages,w.code)||warningCodes.has(w.code)||w.message!==messages[w.code]||!Number.isSafeInteger(w.count)||w.count<1||w.count>100000)fail();warningCodes.add(w.code);}
  if(!warningCodes.has('APPFLOWY_NATIVE_SUBSET')||plan.collections.length&&!warningCodes.has('NATIVE_DATABASE_TEXT'))fail();
  const expectedLinks=[];let linkIndex=0;
  for(const p of plan.pages){const visit=bs=>{for(const b of bs){for(const ref of b.data.links??[])expectedLinks.push({id:'af-link-'+(++linkIndex),sourceId:p.id,blockId:b.id,...ref,kind:ref.sourceAssetId?'attachment':'page',targetId:ref.sourceAssetId??ref.sourcePageId});if(b.children)visit(b.children);}};visit(p.blocks);}
  if(stable(plan.links)!==stable(expectedLinks))fail();
  const expectedUnsupported=plan.entries.filter(e=>e.kind==='unsupported').map(e=>({entryId:e.id,reason:/\.collab$/i.test(e.path)?'BINARY_COLLAB_NOT_REPLAYED':'NATIVE_METADATA_ONLY'}));
  if(stable(plan.unsupported)!==stable(expectedUnsupported))fail();
  const expectedSummary={entries:plan.entries.length,pages:plan.pages.length,collections:plan.collections.length,records:plan.collections.reduce((n,c)=>n+c.rows.length,0),attachments:assetIds.size,links:expectedLinks.length,unresolvedLinks:plan.warnings.find(w=>w.code==='NATIVE_UNRESOLVED_LINK')?.count??0,matchingCandidates:0,unsupported:expectedUnsupported.length};
  if(Object.entries(expectedSummary).some(([k,v])=>plan.summary[k]!==v)||!Number.isSafeInteger(plan.summary.archiveBytes)||plan.summary.archiveBytes<0||plan.summary.archiveBytes>64*1024*1024||plan.summary.uncompressedBytes!==plan.entries.reduce((n,e)=>n+e.bytes,0)||plan.summary.uncompressedBytes>64*1024*1024)fail();
  return plan;
}
export function prepareAppFlowyNativeBundle(untrustedPlan,options={}) {
  const plan=validatedPlan(untrustedPlan),opts=captureJSON(options);
  exactObject(opts,['expectedRevision','importId'],['rootTitle','assets','acknowledgements','csvMode','rowPageMappings']);
  if(opts.csvMode!==undefined&&opts.csvMode!=='native'||opts.rowPageMappings!==undefined&&(!Array.isArray(opts.rowPageMappings)||opts.rowPageMappings.length))fail('INVALID_IMPORT_OPTIONS');
  if(!Number.isSafeInteger(opts.expectedRevision)||opts.expectedRevision<0)fail('INVALID_IMPORT_OPTIONS');
  sourceId(opts.importId);if(opts.rootTitle!==undefined){text(opts.rootTitle,240);if(!opts.rootTitle.trim())fail('INVALID_IMPORT_OPTIONS');}
  const pages=[{sourceId:'import-root',parentSourceId:null,title:opts.rootTitle??'AppFlowy import',blocks:[]}];
  const assets=opts.assets??[];if(!Array.isArray(assets)||assets.length>100)fail('INVALID_IMPORT_OPTIONS');
  const sourceAssets=new Set(),opaqueAssets=new Set(),allAssets=new Map(plan.entries.filter(e=>e.kind==='attachment').map(e=>[e.id,e]));
  for(const asset of assets){exactObject(asset,['sourceId','assetId']);sourceId(asset.sourceId);sourceId(asset.assetId);if(!allAssets.has(asset.sourceId)||sourceAssets.has(asset.sourceId)||opaqueAssets.has(asset.assetId))fail('INVALID_IMPORT_OPTIONS');sourceAssets.add(asset.sourceId);opaqueAssets.add(asset.assetId);}
  let excludedLinks=0;
  const copyBlocks=blocks=>blocks.map(b=>{const next=clone(b);if(next.data.links){next.data.links=next.data.links.filter(l=>!l.sourceAssetId||sourceAssets.has(l.sourceAssetId));excludedLinks+=(b.data.links.length-next.data.links.length);if(!next.data.links.length)delete next.data.links;}if(b.children)next.children=copyBlocks(b.children);return next;});
  for(const p of plan.pages)pages.push({sourceId:p.id,parentSourceId:p.parentCandidateId??'import-root',title:p.title,blocks:copyBlocks(p.blocks)});
  if(pages.length>500)fail('IMPORT_PAGE_LIMIT');
  const collections=plan.collections.map(c=>({sourceId:c.id,pageSourceId:c.pageId,properties:c.columns.map(col=>({id:col.id,name:col.name,type:'text',sourceName:col.sourceName})),records:c.rows.map(row=>({sourceId:c.id+'-'+row.id,pageSourceId:row.pageId,values:Object.fromEntries(c.columns.map((col,i)=>[col.id,row.cells[i]]))}))}));
  const body={expectedRevision:opts.expectedRevision,importId:opts.importId,pages,...(collections.length?{collections}: {})};
  if(assets.length){
    let bindings=0;body.assets=assets.map(asset=>{const ids=new Set();const visit=(blocks,pid)=>{for(const b of blocks){if(b.data.links?.some(l=>l.sourceAssetId===asset.sourceId))ids.add(pid);if(b.children)visit(b.children,pid);}};for(const p of pages)visit(p.blocks,p.sourceId);if(!ids.size)ids.add('import-root');bindings+=ids.size;return{...asset,pageSourceIds:[...ids]};});
    if(bindings>1000)fail('IMPORT_ASSET_LIMIT');
  }
  const bodyBytes=encoder.encode(JSON.stringify(body)).length;if(bodyBytes>768000){const error=new AppFlowyNativeError('IMPORT_BUNDLE_TOO_LARGE');error.details=Object.freeze({pages:pages.length,bodyBytes,limitBytes:768000});throw error;}
  const requiredAcknowledgements=['nativeSubset',...(collections.length?['csvTextTypes']:[]),...(allAssets.size>sourceAssets.size?['excludedAssets']:[]),'linksUnconverted'];
  const warnings=plan.warnings.filter(w=>record(w)&&typeof w.code==='string'&&typeof w.message==='string'&&Number.isSafeInteger(w.count)&&w.count>0).map(clone);
  if(allAssets.size>sourceAssets.size)warnings.push({code:'NATIVE_ASSETS_EXCLUDED',count:allAssets.size-sourceAssets.size,message:messages.NATIVE_ASSETS_EXCLUDED});
  return{body,summary:{pages:pages.length,collections:collections.length,records:collections.reduce((n,c)=>n+c.records.length,0),bodyBytes,attachmentsIncluded:assets.length,attachmentsExcluded:allAssets.size-sourceAssets.size,nativeCollections:collections.length,mappedRows:0,convertedLinks:plan.links.length-excludedLinks,unconvertedLinks:excludedLinks+(plan.summary.unresolvedLinks??0),unsupportedExcluded:plan.unsupported.length,linksConverted:plan.links.length-excludedLinks},warnings,requiredAcknowledgements};
}
export function buildAppFlowyNativeBundle(plan,options={}) {
  const prepared=prepareAppFlowyNativeBundle(plan,options),acks=options.acknowledgements??{};
  if(!record(acks)||Object.entries(acks).some(([k,v])=>!['nativeSubset','csvTextTypes','excludedAssets','linksUnconverted'].includes(k)||typeof v!=='boolean'))fail('INVALID_IMPORT_OPTIONS');
  const missing=prepared.requiredAcknowledgements.filter(k=>acks[k]!==true);
  if(missing.length)throw new AppFlowyNativeError('ACKNOWLEDGEMENT_REQUIRED',missing);
  return prepared;
}
