import test from 'node:test';
import assert from 'node:assert/strict';
import {recordPanelSizeRange,clampRecordPanelSize,readRecordPanelSize,mountRecordPanelSize} from '../public/record-panel-size.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';

function fixture(t){
 const f=settingsDomFixture(t),win=new EventTarget(),frames=new Map(),storage=new Map();let serial=0,captured;
 Object.assign(win,{innerWidth:1600,requestAnimationFrame:fn=>{frames.set(++serial,fn);return serial;},cancelAnimationFrame:id=>frames.delete(id),localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}});f.doc.defaultView=win;
 const sidebar=f.doc.createElement('aside');sidebar.className='workspace-sidebar';sidebar.getBoundingClientRect=()=>({width:256});f.doc.body.append(sidebar);
 const host=f.doc.createElement('aside'),editor=f.doc.createElement('iframe');host.append(editor);f.doc.body.append(host);
 const model={workspaceId:'studio',accountId:'owner',resizeLabel:'Resize',resizeKeys:'Keys',resizeValue:width=>'Width '+width};
 const control=mountRecordPanelSize({document:f.doc,host,model}),handle=control.handle;
 Object.assign(handle,{setPointerCapture:id=>{captured=id;},hasPointerCapture:id=>captured===id,releasePointerCapture:()=>{captured=null;}});
 const send=(type,values={},target=handle)=>{const event=new Event(type,{cancelable:true});Object.assign(event,{button:0,isPrimary:true,pointerId:1,clientX:980,...values});if(target.dispatchEvent)target.dispatchEvent(event);else for(const fn of (target===f.doc?f.listeners:target.listeners).get(type)??[])fn(event);return event;};
 const width=()=>Number.parseInt(host.style['--record-panel-width']);t.after(()=>control.destroy());
 return{...f,win,host,editor,handle,control,model,frames,storage,send,width,flush(){for(const[id,fn]of frames){frames.delete(id);fn();}}};
}
test('panel bounds reserve document space and saved widths tolerate unavailable or invalid storage',()=>{
 assert.deepEqual(recordPanelSizeRange(1600,256),{min:320,max:984});assert.equal(clampRecordPanelSize(1000,1600,480),760);assert.equal(clampRecordPanelSize(900,800),736);assert.equal(clampRecordPanelSize(-1,1440),320);
 for(const text of ['invalid','null',' '.repeat(129),JSON.stringify({version:2,width:700}),JSON.stringify({version:1,width:'700'})])assert.equal(readRecordPanelSize({getItem:()=>text},'key'),620);
 assert.equal(readRecordPanelSize({getItem(){throw Error();}},'key'),620);assert.equal(readRecordPanelSize({getItem:()=>JSON.stringify({version:1,width:700})},'key'),700);
});
test('pointer resize persists on release, adjusts the host margin, and never replaces the editor',t=>{
 const f=fixture(t);f.background.scrollTop=380;f.send('pointerdown');f.send('pointermove',{clientX:850});f.send('pointermove',{clientX:820});assert.equal(f.frames.size,1);f.flush();assert.equal(f.width(),780);assert.equal(f.storage.size,0);f.send('pointerup',{clientX:800});assert.equal(f.width(),800);assert.equal(f.doc.body.style['--record-panel-width'],'800px');assert.equal(f.host.querySelector('iframe'),f.editor);assert.equal(f.background.scrollTop,380);assert.equal(JSON.parse([...f.storage.values()][0]).width,800);assert.equal(f.handle.getAttribute('aria-valuenow'),'800');
 f.control.destroy();assert.equal(f.doc.body.style['--record-panel-width'],undefined);assert.equal(f.host.querySelector('iframe'),f.editor);
});
test('Escape and IME cancellation restore a preview without writing or closing the panel',t=>{
 const f=fixture(t);f.send('pointerdown');f.send('pointermove',{clientX:850});f.flush();assert.equal(f.width(),750);assert.equal(f.send('keydown',{key:'Escape'}).defaultPrevented,true);assert.equal(f.width(),620);assert.equal(f.storage.size,0);assert.equal(f.host.isConnected,true);
 f.send('compositionstart',{},f.doc);assert.equal(f.send('keydown',{key:'ArrowLeft'}).defaultPrevented,false);f.send('pointerdown');assert.equal(f.doc.body.classList.contains('record-panel-resizing'),false);f.send('compositionend',{},f.doc);
});
test('keyboard direction follows the panel edge, viewport changes retain preferred width, and reset is local',t=>{
 const f=fixture(t);f.send('keydown',{key:'ArrowLeft',shiftKey:true});assert.equal(f.width(),652);f.send('keydown',{key:'ArrowRight'});assert.equal(f.width(),644);f.send('keydown',{key:'End'});assert.equal(f.width(),984);
 f.win.innerWidth=1200;f.send('resize',{},f.win);assert.equal(f.width(),584);f.win.innerWidth=1600;f.send('resize',{},f.win);assert.equal(f.width(),984);f.send('keydown',{key:'Enter'});assert.equal(f.width(),620);
 f.win.innerWidth=600;f.send('resize',{},f.win);assert.equal(f.width(),600);f.send('pointerdown');f.send('keydown',{key:'ArrowLeft'});assert.equal(f.width(),600);assert.equal(f.host.querySelector('iframe'),f.editor);
});
