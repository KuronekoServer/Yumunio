import test from 'node:test';
import assert from 'node:assert/strict';
import {inlineDomFixture} from './fixtures/inline-dom.js';
import {createInlineEditor} from '../public/inline-editor.js';
import {participantRoster,participantColor,remoteCursorLayer} from '../public/room-presence-ui.js';

// Extend fixture instances here: production geometry still comes from DOM Ranges.
// This does not simulate layout, actual browser selection or real pointer input.
function presenceDom(t,{clip={left:40,right:160,top:60,bottom:140},rects=[],caret={left:120,right:120,top:100,bottom:120,width:0,height:20}}={}){
 const dom=inlineDomFixture(t),doc=dom.document,create=doc.createElement.bind(doc),ranges=[],editors=[];
 doc.defaultView={innerWidth:300,innerHeight:200};
 doc.createElement=tag=>{const element=create(tag);element.dataset={};element.style={setProperty(name,value){this[name]=value;}};return element;};
 const createRange=doc.createRange.bind(doc);
 doc.createRange=()=>{
  const range=createRange();range.collapsedToStart=null;
  range.collapse=start=>{range.beforeCollapse={startContainer:range.startContainer,startOffset:range.startOffset,endContainer:range.endContainer,endOffset:range.endOffset};range.collapsedToStart=start;if(start){range.endContainer=range.startContainer;range.endOffset=range.startOffset;}else{range.startContainer=range.endContainer;range.startOffset=range.endOffset;}};
  range.getClientRects=()=>rects;
  range.getBoundingClientRect=()=>typeof caret==='function'?caret(range):caret;
  ranges.push(range);return range;
 };
 const root=doc.createElement('main'),scroll=doc.createElement('div');scroll.getBoundingClientRect=()=>clip;root.append(scroll);
 root.querySelectorAll=selector=>selector==='.inline-editor[data-block-id]'?editors:[];
 root.querySelector=selector=>selector==='.workspace-scroll'?scroll:null;
 function editor(text,{id='body',pageId='page',marks=[],mentions=[],bounds={left:45,right:150,top:80,bottom:104,width:105,height:24}}={}){
  const input=createInlineEditor({text,marks,mentions,readOnly:true,label:'Read-only body'});input.dataset={blockId:id,pageId};input.getBoundingClientRect=()=>bounds;scroll.append(input);editors.push(input);return input;
 }
 return{...dom,root,scroll,ranges,editor};
}
const person=(extra={})=>({id:'ephemeral-person',displayName:'Guest',self:false,cursor:{blockId:'body',start:0,end:0,direction:'forward'},...extra});
const byClass=(layer,name)=>layer.childNodes.filter(node=>node.className===name);
const geometry=node=>Object.fromEntries(['left','top','width','height'].filter(key=>node.style[key]!==undefined).map(key=>[key,parseFloat(node.style[key])]));
function insets(layer){const match=/^inset\(([^)]+)\)$/.exec(layer.style.clipPath||'');assert.ok(match,'the fixed overlay must clip its labels to the visible document viewport');return match[1].trim().split(/\s+/).map(parseFloat);}

test('participant roster renders literal names and localized self labels without exposing account or session identifiers',t=>{
 const dom=presenceDom(t),roster=participantRoster(dom.document,[person({displayName:'<script>literal</script>',accountId:'private-account',sessionId:'private-session'}),person({id:'self-id',displayName:'Me',self:true})],{label:'People',you:'Self'});
 assert.equal(roster.getAttribute('role'),'list');assert.equal(roster.getAttribute('aria-label'),'People');
 assert.equal(roster.childNodes[0].getAttribute('role'),'listitem');assert.equal(roster.textContent,'<script>literal</script>Me (Self)');
 assert.equal(roster.childNodes[0].getAttribute('data-account-id'),null);assert.equal(roster.childNodes[0].getAttribute('data-session-id'),null);
 assert.equal(roster.childNodes[0].childNodes[1].getAttribute('translate'),'no');
 assert.match(participantColor('ephemeral-person'),/^#[a-f0-9]{6}$/);assert.equal(participantColor('ephemeral-person'),participantColor('ephemeral-person'));
 assert.equal(participantRoster(dom.document,[],{waiting:'Waiting'}).textContent,'Waiting');
});

test('UTF16 offsets cross formatted text nodes and forward/backward selection chooses the correct caret endpoint without touching read-only content',t=>{
 const dom=presenceDom(t,{rects:[{left:60,right:140,top:80,bottom:100,width:80,height:20}],caret:range=>range.collapsedToStart?{left:60,right:60,top:80,bottom:100,width:0,height:20}:{left:140,right:140,top:80,bottom:100,width:0,height:20}});
 const input=dom.editor('AB\u{1f600}CD',{marks:[{start:1,end:4,styles:['bold']}]});const before=input.getInlineState(),nodes=[...input.childNodes],texts=dom.textNodes(input);
 assert.deepEqual(texts.map(node=>node.textContent),['A','B\u{1f600}','CD']);
 for(const direction of ['forward','backward']){
  const layer=remoteCursorLayer(dom.document,dom.root,[person({cursor:{blockId:'body',start:2,end:5,direction}})],{pageId:'page'}),range=dom.ranges.at(-1);
  assert.equal(range.beforeCollapse.startContainer,texts[1]);assert.equal(range.beforeCollapse.startOffset,1);assert.equal(range.beforeCollapse.endContainer,texts[2]);assert.equal(range.beforeCollapse.endOffset,1);
  assert.equal(range.collapsedToStart,direction==='backward');assert.equal(geometry(byClass(layer,'room-remote-caret')[0]).left,direction==='backward'?60:140);
  dom.root.append(layer);assert.equal(input.contains(layer),false);assert.equal(layer.getAttribute('aria-hidden'),'true');
 }
 assert.equal(input.textContent,'AB\u{1f600}CD');assert.deepEqual(input.getInlineState(),before);assert.deepEqual(input.childNodes,nodes);
});

test('self cursors, another page, missing blocks and out-of-range offsets produce no remote caret or body mutation',t=>{
 const dom=presenceDom(t),input=dom.editor('body'),before=input.getInlineState();
 const participants=[person({self:true}),person({cursor:{blockId:'missing',start:0,end:0,direction:'forward'}}),person({cursor:{blockId:'body',start:-1,end:0,direction:'forward'}}),person({cursor:{blockId:'body',start:0,end:5,direction:'forward'}})];
 assert.equal(remoteCursorLayer(dom.document,dom.root,participants,{pageId:'page'}).childNodes.length,0);
 assert.equal(remoteCursorLayer(dom.document,dom.root,[person()],{pageId:'other-page'}).childNodes.length,0);
 assert.deepEqual(input.getInlineState(),before);assert.equal(input.textContent,'body');
});

test('selection rectangles intersect the document viewport and cap visual fragments to keep large selections bounded',t=>{
 const rect={left:20,right:200,top:50,bottom:70,width:180,height:20},dom=presenceDom(t,{rects:Array.from({length:130},()=>rect)});
 dom.editor('range');const layer=remoteCursorLayer(dom.document,dom.root,[person({cursor:{blockId:'body',start:0,end:5,direction:'forward'}})],{pageId:'page'});
 const fragments=byClass(layer,'room-remote-selection');assert.equal(fragments.length,100);assert.deepEqual(geometry(fragments[0]),{left:40,top:60,width:120,height:10});
 assert.deepEqual(insets(layer),[60,140,60,40]);assert.equal(byClass(layer,'room-remote-caret').length,1);
});

test('a caret crossing the scroll boundary uses only its visible height and clips its floating label',t=>{
 const dom=presenceDom(t,{caret:{left:50,right:50,top:50,bottom:70,width:0,height:20}});dom.editor('body');
 const layer=remoteCursorLayer(dom.document,dom.root,[person()],{pageId:'page'}),caret=byClass(layer,'room-remote-caret')[0];
 assert.deepEqual(geometry(caret),{left:50,top:60,height:10});assert.deepEqual(insets(layer),[60,140,60,40]);
 assert.equal(caret.childNodes[0].textContent,'Guest');assert.equal(caret.childNodes[0].getAttribute('translate'),'no');
});

test('empty read-only paragraphs use a bounded fallback caret while offscreen ranges remain hidden',t=>{
 const dom=presenceDom(t,{caret:{left:0,right:0,top:0,bottom:0,width:0,height:0}});
 const input=dom.editor('',{bounds:{left:45,right:150,top:55,bottom:79,width:105,height:24}});
 const layer=remoteCursorLayer(dom.document,dom.root,[person()],{pageId:'page'});assert.deepEqual(geometry(byClass(layer,'room-remote-caret')[0]),{left:45,top:60,height:19});assert.equal(input.textContent,'');
 input.getBoundingClientRect=()=>({left:200,right:250,top:90,bottom:114,width:50,height:24});assert.equal(remoteCursorLayer(dom.document,dom.root,[person()],{pageId:'page'}).childNodes.length,0);
});

test('scroll bounds outside the screen normalize to the visible viewport instead of creating negative overlay insets',t=>{
 const dom=presenceDom(t,{clip:{left:-30,right:340,top:-10,bottom:230},caret:{left:0,right:0,top:190,bottom:210,width:0,height:20}});dom.editor('body');
 const layer=remoteCursorLayer(dom.document,dom.root,[person()],{pageId:'page'});assert.deepEqual(insets(layer),[0,0,0,0]);assert.deepEqual(geometry(byClass(layer,'room-remote-caret')[0]),{left:0,top:190,height:10});
});
