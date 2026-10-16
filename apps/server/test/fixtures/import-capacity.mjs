export function largeImportBundle(expectedRevision) {
  const properties = [{id:'name',name:'Name',type:'text'},{id:'original',name:'Original',type:'text'}];
  const pages = [{sourceId:'root',parentSourceId:null,title:'Synthetic native import',blocks:[]},
    {sourceId:'table',parentSourceId:'root',title:'Imported records',blocks:[{id:'headers',type:'code',data:{purpose:'import-source',text:'["Name","Original"]'}}]}];
  const records = Array.from({length:125},(_,index)=>{
    const sourceId='row-'+index,values={name:'Row '+index,original:index%2?'007':'=SUM(A1)'};
    pages.push({sourceId,parentSourceId:'table',title:values.name,blocks:[{id:'source-row',type:'code',data:{purpose:'import-source',text:JSON.stringify(values)}}]});
    return {sourceId:'record-'+index,pageSourceId:sourceId,values};
  });
  for(let index=0;index<133;index++)pages.push({sourceId:'note-'+index,parentSourceId:'root',title:'Note '+index,
    blocks:[{id:'literal',type:'paragraph',data:{text:'Synthetic literal paragraph '.repeat(90)}}]});
  return {expectedRevision,importId:'synthetic-large-native-import',pages:pages.reverse(),collections:[{sourceId:'records',pageSourceId:'table',properties,records}]};
}
