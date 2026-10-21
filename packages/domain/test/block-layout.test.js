import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBlocks,columnWidths,resizeColumnBoundary,changeColumnCountWidths,validColumnWidths,createBlockColumnPlanner,arrangeBlockColumns,moveBlockForest,isAttachmentBlock,isDatabaseBlock} from '../src/index.js';
const p=(id,text=id,extra={})=>({id,type:'paragraph',data:{text},...extra});
const columns=widths=>({id:'group',type:'columns',...(widths?{data:{widths}}:{}),children:[{id:'left',type:'column',children:[p('a')]},{id:'right',type:'column',children:[p('b')]}]});
const db=()=>({id:'db',type:'database',data:{format:'collection-view-v1',collectionId:'source',view:{name:'Table',type:'table',filters:[],sorts:[],groupBy:null,datePropertyId:null,endDatePropertyId:null},visiblePropertyIds:null,presentation:{title:'Tasks',showTitle:false,height:360}}});
test('column proportions round-trip through the domain and preserve legacy equal layouts',()=>{
 assert.deepEqual(columnWidths(columns()),[500,500]);const input=[columns([650,350])];assert.deepEqual(validateBlocks(JSON.parse(JSON.stringify(input))),input);
 for(const widths of [[500,499],[149,851],[500,500,0],[500.5,499.5],['500',500],null])assert.throws(()=>validateBlocks([columns(widths??[]) ]));
 const unknown=columns([500,500]);unknown.data.future=true;assert.throws(()=>validateBlocks([unknown]));unknown.data={};unknown.children[0].data={widths:[500,500]};assert.throws(()=>validateBlocks([unknown]));
});
test('divider changes clamp one adjacent pair without moving the third column',()=>{
 const original=[250,350,400];assert.deepEqual(resizeColumnBoundary(original,0,83.2),[333,267,400]);assert.deepEqual(resizeColumnBoundary(original,0,900),[450,150,400]);assert.deepEqual(resizeColumnBoundary(original,1,-900),[250,150,600]);assert.deepEqual(original,[250,350,400]);
 for(const index of [-1,2,null])assert.throws(()=>resizeColumnBoundary(original,index,10));
 for(const widths of [[150,850],[600,400],[850,150]]){const third=changeColumnCountWidths(widths,3);assert.ok(validColumnWidths(third));assert.equal(third[2],333);assert.ok(validColumnWidths(changeColumnCountWidths(third,2)));}
});
test('side placement moves complete rich blocks and source references without cloning their identities',()=>{
 const rich=p('rich','日本語',{data:{text:'日本語',marks:[{start:0,end:3,styles:['bold']}],future:{keep:true}},children:[p('child')]}),input=[p('before'),rich,db(),p('after')],before=structuredClone(input),plan=createBlockColumnPlanner(input);
 assert.deepEqual(plan({blockIds:['rich','child'],targetId:'db',side:'right'}),{blockIds:['rich'],targetId:'db',side:'right'});assert.deepEqual(input,before);
 const result=arrangeBlockColumns(input,{blockIds:['rich'],targetId:'db',side:'right',groupId:'new',columnIds:['one','two']});assert.deepEqual(result.blocks[1].children[0].children,[db()]);assert.deepEqual(result.blocks[1].children[1].children,[rich]);assert.equal(result.blocks[2].id,'after');assert.deepEqual(input,before);validateBlocks(result.blocks);
 const moved=moveBlockForest(result.blocks,[],{blockIds:['new'],index:0});assert.equal(moved.targetBlocks[0].id,'new');
});
test('cycle, protected source, nested columns, ID collisions and depth failures are atomic',()=>{
 const input=[p('parent','',{children:[p('child')]}),columns([600,400]),p('source','',{data:{text:'original',purpose:'import-source'}})],before=structuredClone(input),run=options=>arrangeBlockColumns(input,{groupId:'new',columnIds:['one','two'],side:'left',...options});
 for(const options of [{blockIds:['parent'],targetId:'child'},{blockIds:['child'],targetId:'parent'},{blockIds:['source'],targetId:'parent'},{blockIds:['parent'],targetId:'a'},{blockIds:['group'],targetId:'parent'},{blockIds:['child'],targetId:'source'},{blockIds:['child'],targetId:'parent',columnIds:['one','one']}])assert.throws(()=>run(options));assert.deepEqual(input,before);
 let nested=p('target');for(let i=0;i<6;i++)nested=p('n'+i,'',{children:[nested]});assert.throws(()=>arrangeBlockColumns([p('moving'),nested],{blockIds:['moving'],targetId:'target',side:'left',groupId:'new',columnIds:['one','two']}),/NESTING_LIMIT/);
});
test('attachment and database presentation permit only bounded local display settings',()=>{
 const file={id:'image',type:'image',data:{format:'attachment-v1',text:'image.png',links:[{start:0,end:9,label:'image.png',pageId:'page',attachmentId:'asset'}],layout:{width:45,align:'center'}}};assert.ok(isAttachmentBlock(file));validateBlocks([file,db()]);
 for(const layout of [{width:0,align:'left'},{width:101,align:'right'},{width:30,align:'url(x)'},{width:50,align:'left',attachmentId:'other'}])assert.equal(isAttachmentBlock({...file,data:{...file.data,layout}}),false);
 for(const presentation of [{height:199},{height:1201},{showTitle:'false'},{title:'bad\u0000'},{icon:'x'.repeat(33)},{sourcePageId:'other'}])assert.equal(isDatabaseBlock({...db(),data:{...db().data,presentation}}),false);
});
