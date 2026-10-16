const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function expandedSource(data) {
  const source=data.source;
  if(data.sourceEncoding!=='appflowy-document-tuples-v1'||!record(source)||!Array.isArray(source.blocks))return source;
  const names=new Set(),entries=[];
  for(const tuple of source.blocks) {
    if(!Array.isArray(tuple)||tuple.length!==6)return source;
    const [key,ty,parent,children,payload,rest]=tuple;
    if(typeof key!=='string'||typeof ty!=='string'||typeof parent!=='string'||typeof children!=='string'||!record(payload)||!record(rest)||names.has(key)||Object.keys(rest).some(name=>['id','ty','parent','children','data'].includes(name)))return source;
    names.add(key);
    entries.push([key,Object.fromEntries([['id',key],['ty',ty],['parent',parent],['children',children],['data',payload],...Object.entries(rest)])]);
  }
  return Object.fromEntries(Object.entries(source).map(([key,value])=>[key,key==='blocks'?Object.fromEntries(entries):value]));
}
/** Render a validated readonly import source; stored JSON remains unchanged. */
export function importSourceText(block) {
  const data=block?.data;
  if(block?.type!=='code'||data?.purpose!=='import-source'||typeof data.text!=='string')return null;
  return Object.hasOwn(data,'source') ? JSON.stringify(expandedSource(data),null,2) : data.text;
}
