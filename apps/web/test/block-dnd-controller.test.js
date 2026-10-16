import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlockDnd } from '../public/block-dnd.js';
import {planBlockForestMove} from '../../../packages/domain/src/block-forest.js';

// These doubles exercise our adapter's lifecycle contract. They do not simulate
// browser sensors, collision detection, rendering or real pointer/touch input.
class Target {
  listeners = new Map();
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
    return () => this.removeEventListener(name, handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  emit(name, event = {}) { for (const handler of [...(this.listeners.get(name) || [])]) handler(event); }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0); }
}
class Element extends Target {
  constructor(doc, { classes = '', dataset = {}, rect = { left: 0, top: 0, width: 280, height: 40 } } = {}) {
    super(); this.ownerDocument = doc; this.children = []; this.dataset = { ...dataset }; this.attributes = new Map(); this.style = {};
    this.rect = rect; this.textContent = ''; this.disabled = false;
    const names = new Set(classes.split(' ').filter(Boolean));
    this.classList = { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name) };
    Object.defineProperty(this, 'className', { get: () => [...names].join(' '), set: value => { names.clear(); for (const name of value.split(' ')) if (name) names.add(name); } });
  }
  get isConnected() { return !!this.connected || !!this.parentElement?.isConnected; }
  append(...elements) { for (const element of elements) { element.parentElement = this; this.children.push(element); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  contains(element) { for (let current = element; current; current = current.parentElement) if (current === this) return true; return false; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  matches(selector) {
    if (selector === '#block-dnd-status') return this.id === 'block-dnd-status';
    if (selector === '.is-block-drag-source') return this.classList.contains('is-block-drag-source');
    if (selector === '.block-row[data-block-id]') return this.classList.contains('block-row') && 'blockId' in this.dataset;
    if (selector === '.block-end-drop') return this.classList.contains('block-end-drop');
    if (selector === '[data-dnd-page-id]') return 'dndPageId' in this.dataset;
    if (selector === '[data-dnd-block-id]') return 'dndBlockId' in this.dataset;
    if (selector === '[data-block-drop]') return 'blockDrop' in this.dataset;
    if (selector === '[data-block-drag-handle]') return 'blockDragHandle' in this.dataset;
    if (selector === '[data-block-drag-handle][aria-pressed="true"]') return 'blockDragHandle' in this.dataset && this.getAttribute('aria-pressed') === 'true';
    return false;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(','), matches = [];
    const visit = parent => { for (const child of parent.children) { if (selectors.some(item => child.matches(item))) matches.push(child); visit(child); } };
    visit(this); return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; }
  focus() { this.ownerDocument.activeElement = this; }
}
class Rectangle {
  constructor(element) { Object.assign(this, element.getBoundingClientRect ? element.getBoundingClientRect() : element); }
  translate(x, y) { return new Rectangle({ left: this.left + x, top: this.top + y, width: this.width, height: this.height }); }
}
function fixture(loadOverride,options={}) {
  const win = new Target(), doc = new Target(); let serial = 0;
  const timers = new Map(), frames = new Map(), managers = [], commits = [], crossPages = [], activeChanges = [];
  Object.assign(win, { innerWidth: 1000, innerHeight: 800,
    setTimeout: callback => { const id = ++serial; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = ++serial; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id) });
  doc.defaultView = win; doc.hasFocus = () => true; doc.querySelector = () => null; doc.createElement = () => new Element(doc);
  doc.body = new Element(doc); doc.body.connected = true;
  const root = new Element(doc), sourceBranch = new Element(doc, { dataset: { dndBlockId: 'source' } });
  const source = new Element(doc, { classes: 'block-row', dataset: { blockId: 'source' }, rect: { left: 100, top: 100, width: 400, height: 40 } });
  const target = new Element(doc, { classes: 'block-row', dataset: { blockId: 'target' }, rect: { left: 100, top: 200, width: 400, height: 100 } });
  for (const row of [source, target]) row.append(new Element(doc, { dataset: { blockDragHandle: '' } }));
  const end = new Element(doc, { classes: 'block-end-drop' }), page = new Element(doc, { dataset: { dndPageId: 'page-b' } });
  const status = new Element(doc); status.id = 'block-dnd-status'; sourceBranch.append(source); root.append(sourceBranch, target, end, page, status); doc.body.append(root);
  let blocks = (options.blockIds?['source','extra','target']:['source','target']).map(id => ({ id, type: 'paragraph', data: { text: id } })), scope = 'account:workspace:page';
  class Manager {
    constructor(config) {
      this.config = config; this.monitor = new Target(); this.draggables = []; this.droppables = []; this.phase = 'idle'; this.destroyed = false;
      this.collisionObserver = { calls: 0, forceUpdate() { this.calls++; } };
      this.dragOperation = { source: null, target: null, shape: null, canceled: false, position: { current: { x: 300, y: 120 } }, snapshot: () => this.operation() };
      this.actions = { stop: ({ canceled = false } = {}) => this.end({ canceled }) }; managers.push(this);
    }
    operation() { return { ...this.dragOperation, position: { current: { ...this.dragOperation.position.current } } }; }
    prepare() {
      this.dragOperation.source = this.draggables.find(item => item.data.blockId === 'source');
      let prevented = false;
      this.monitor.emit('beforedragstart', { operation: this.operation(), preventDefault() { prevented = true; } });
      assert.equal(prevented, false); this.phase = 'initializing';
    }
    start() { this.phase = 'dragging'; this.monitor.emit('dragstart', { operation: this.operation() }); }
    end({ canceled = false, operationCanceled = canceled, point = { x: 300, y: 250 }, pageId, targetId='target',nativeEvent } = {}) {
      this.dragOperation.target = this.droppables.find(item => pageId?item.data.kind==='page'&&item.data.pageId===pageId:item.data.kind === 'block' && item.data.blockId === targetId);
      this.dragOperation.position.current = point; this.dragOperation.canceled = operationCanceled; this.phase = 'cleanup-pending';
      this.monitor.emit('dragend', { operation: this.operation(), canceled,nativeEvent }); this.phase = 'cleaned';
    }
    destroy() { this.destroyed = true; }
  }
  class Entity {
    constructor(input, manager) { Object.assign(this, input); this.manager = manager; this.destroyed = false; }
    destroy() { this.destroyed = true; }
  }
  class Draggable extends Entity { constructor(input, manager) { super(input, manager); manager.draggables.push(this); } }
  class Droppable extends Entity {
    constructor(input, manager) { super(input, manager); manager.droppables.push(this); this.measurements = 0; }
    refreshShape() { this.measurements++; }
    accepts(source) { return this.accept(source); }
  }
  class Configurable { static configure(options) { return { plugin: this, options }; } }
  class Constraint { constructor(options) { this.options = options; } }
  const toolkit = { DragDropManager: Manager, Draggable, Droppable, PointerSensor: Configurable, KeyboardSensor: Configurable,
    PointerActivationConstraints: { Delay: Constraint, Distance: Constraint }, Feedback: Configurable, Accessibility: class {}, DOMRectangle: Rectangle };
  const controller = createBlockDnd({ root, canStart: id => blocks.some(block => block.id === id), getScope: () => scope, getBlocks: () => blocks,...(options.blockIds?{getBlockIds:()=>options.blockIds}:{}),
    ...(Object.hasOwn(options,'allowMultiPageTransfer')?{allowMultiPageTransfer:options.allowMultiPageTransfer}:{}),
    onCommit: operation => { commits.push({ operation, phase: managers[0].phase }); return true; }, onActiveChange: (...change) => activeChanges.push(change),
    ...(options.canDropOnPage?{canDropOnPage:options.canDropOnPage}:{}),onCrossPage:operation=>{crossPages.push({operation,phase:managers[0].phase});return options.crossPageResult??true;},
    loadToolkit: loadOverride || (() => toolkit) });
  return { controller, toolkit, root, doc, win, managers, source, target, status, commits, crossPages, activeChanges, timers, frames,
    get blocks() { return blocks; }, set blocks(value) { blocks = value; }, set scope(value) { scope = value; },
    flushTimers() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); },
    flushFrames() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    get overlays() { return doc.body.children.filter(element => element.classList.contains('block-dnd-overlay')); } };
}
function assertDestroyed(f) {
  assert.equal(f.overlays.length, 0); assert.equal(f.root.classList.contains('block-dragging'), false);
  assert.equal(f.doc.listenerCount + f.win.listenerCount, 0);
  for (const manager of f.managers) {
    assert.equal(manager.destroyed, true); assert.equal(manager.monitor.listenerCount, 0);
    assert.ok([...manager.draggables, ...manager.droppables].every(entity => entity.destroyed));
  }
}

test('an optional page predicate rejects unsupported branches before sidebar acceptance and preview',async()=>{
 const checked=[],f=fixture(null,{canDropOnPage:value=>{checked.push(value);return false;}});await f.controller.ready;
 const manager=f.managers[0];manager.prepare();const page=manager.droppables.find(item=>item.data.kind==='page');
 assert.equal(page.accept(manager.dragOperation.source),false);assert.deepEqual(checked[0],{blockId:'source',blockIds:undefined,pageId:'page-b'});
 manager.start();manager.dragOperation.target=page;manager.dragOperation.position.current={x:100,y:20};manager.monitor.emit('dragover',{operation:manager.operation()});
 assert.equal(page.element.dataset.blockDrop,undefined);assert.equal(f.status.textContent,'invalid');assert.equal(f.overlays[0].dataset.valid,'false');
 manager.end({pageId:'page-b',point:{x:100,y:20}});f.flushTimers();f.flushFrames();assert.equal(f.crossPages.length,0);assert.equal(f.status.textContent,'canceled');assert.equal(f.doc.activeElement,f.source.querySelector('[data-block-drag-handle]'));f.controller.destroy();assertDestroyed(f);
});

test('default single-block sidebar drops keep working while a declined callback reports cancellation and restores the handle',async()=>{
 for(const accepted of [true,false]){
  const f=fixture(null,{crossPageResult:accepted});await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();
  assert.equal(manager.droppables.find(item=>item.data.kind==='page').accept(manager.dragOperation.source),true);
  manager.end({pageId:'page-b',point:{x:100,y:20}});assert.equal(f.crossPages.length,0);f.flushTimers();f.flushFrames();
  assert.deepEqual(f.crossPages,[{operation:{blockId:'source',pageId:'page-b'},phase:'cleaned'}]);assert.equal(f.status.textContent,accepted?'page':'canceled');if(!accepted)assert.equal(f.doc.activeElement,f.source.querySelector('[data-block-drag-handle]'));
  f.controller.destroy();assertDestroyed(f);
 }
});

test('page acceptance is rechecked at the deferred commit boundary and predicate failures close the operation',async()=>{
 for(const throwOnRecheck of [false,true]){
  let allowed=true;const f=fixture(null,{canDropOnPage:()=>{if(!allowed&&throwOnRecheck)throw Error('Latest source unavailable');return allowed;}});await f.controller.ready;
  const manager=f.managers[0];manager.prepare();manager.start();manager.end({pageId:'page-b',point:{x:100,y:20}});assert.equal(f.timers.size,1);allowed=false;f.flushTimers();f.flushFrames();
  assert.equal(f.crossPages.length,0);assert.equal(f.status.textContent,'canceled');assert.equal(f.doc.activeElement,f.source.querySelector('[data-block-drag-handle]'));f.controller.destroy();assertDestroyed(f);
 }
});

test('destroy before asynchronous toolkit resolution does not register a manager or leave document listeners', async () => {
  let resolveToolkit;
  const f = fixture(() => new Promise(resolve => { resolveToolkit = resolve; }));
  await Promise.resolve(); assert.equal(typeof resolveToolkit, 'function');
  assert.ok(f.doc.listenerCount + f.win.listenerCount > 0);
  f.controller.destroy(); resolveToolkit(f.toolkit); await f.controller.ready;
  assert.equal(f.managers.length, 0); assert.equal(f.root.dataset.blockDnd, undefined); assertDestroyed(f);
});

test('pending drag accepts targets during SDK initialization and supplies a translated virtual shape', async () => {
  const f = fixture(); await f.controller.ready; const manager = f.managers[0];
  manager.prepare(); assert.equal(f.controller.active, false);
  const source = manager.dragOperation.source, target = manager.droppables.find(item => item.data.blockId === 'target');
  assert.equal(target.accept(source), true, 'SDK observers evaluate acceptance before dragstart');
  assert.equal(manager.droppables.find(item => item.data.blockId === 'source').accept(source), false);
  assert.ok(manager.droppables.filter(item => ['end', 'page'].includes(item.data.kind)).every(item => item.accept(source)));
  manager.start(); assert.equal(f.controller.active, true); assert.ok(manager.dragOperation.shape instanceof Rectangle);
  assert.ok(manager.droppables.every(item => item.measurements > 0)); assert.ok(manager.collisionObserver.calls > 0);
  assert.equal(f.overlays.length, 1); assert.equal(f.source.parentElement.dataset.dndBlockId, 'source', 'editor row stays in its original parent');
  manager.monitor.emit('dragmove', { operation: manager.operation(), by: { x: 24, y: 16 } });
  assert.equal(manager.dragOperation.shape.left, 124); assert.equal(manager.dragOperation.shape.top, 116);
  manager.dragOperation.position.current = { x: 324, y: 136 }; f.flushFrames();
  f.controller.destroy(); assert.deepEqual(f.activeChanges, [[true, 'source'], [false, 'source']]); assertDestroyed(f);
});

test('canceled, outside and stale-scope drag ends never commit and remove transient visuals', async () => {
  for (const scenario of ['canceled', 'outside', 'scope', 'blur']) {
    const f = fixture(); await f.controller.ready; const manager = f.managers[0]; manager.prepare(); manager.start();
    if (scenario === 'scope') f.scope = 'another:page';
    if (scenario === 'blur') f.win.emit('blur');
    else manager.end(scenario === 'canceled' ? { canceled: true, operationCanceled: false } : scenario === 'outside' ? { point: { x: 99, y: 250 } } : {});
    f.flushTimers(); f.flushFrames(); assert.equal(f.commits.length, 0, scenario); assert.equal(f.overlays.length, 0, scenario);
    assert.equal(f.target.dataset.blockDrop, undefined); f.controller.destroy(); assertDestroyed(f);
  }
});

test('a drop commits after SDK cleanup and revalidates the tree and scope again at the deferred boundary', async () => {
  for (const scenario of ['valid', 'invalidated-tree', 'changed-scope']) {
    const f = fixture(); await f.controller.ready; const manager = f.managers[0]; manager.prepare(); manager.start(); manager.end();
    assert.equal(f.commits.length, 0, 'application render must not interrupt SDK dragend cleanup');
    assert.equal(f.timers.size, 1); assert.equal(f.overlays.length, 0);
    if (scenario === 'invalidated-tree') f.blocks[1].type = 'code';
    if (scenario === 'changed-scope') f.scope = 'another:page';
    f.flushTimers();
    if (scenario === 'valid') assert.deepEqual(f.commits, [{ operation: { blockId: 'source', targetId: 'target', placement: 'inside' }, phase: 'cleaned' }]);
    else assert.equal(f.commits.length, 0, scenario);
    f.controller.destroy(); assertDestroyed(f);
  }
});


test('multi-block selection keeps page transfers disabled by default while in-page moves retain the whole captured forest',async()=>{
 const f=fixture(undefined,{blockIds:['extra','source']}),before=structuredClone(f.blocks);await f.controller.ready;const manager=f.managers[0];
 manager.prepare();const source=manager.dragOperation.source;
 assert.equal(manager.droppables.find(item=>item.data.kind==='page').accept(source),false);
 assert.equal(manager.droppables.find(item=>item.data.blockId==='target').accept(source),true);
 manager.start();assert.equal(f.overlays[0].children[0].textContent,'selection');assert.deepEqual(f.blocks,before);
 manager.end();assert.equal(f.commits.length,0);f.flushTimers();
 assert.deepEqual(f.commits,[{operation:{blockId:'source',blockIds:['source','extra'],targetId:'target',placement:'inside'},phase:'cleaned'}]);
 f.controller.destroy();assertDestroyed(f);
});

test('a selected forest is revalidated after cleanup so one removed or readonly source cancels the whole move',async()=>{
 for(const invalid of ['removed','readonly']){
  const f=fixture(undefined,{blockIds:['source','extra']});await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();manager.end();
  if(invalid==='removed')f.blocks=f.blocks.filter(block=>block.id!=='extra');else f.blocks.find(block=>block.id==='extra').data.purpose='import-source';
  f.flushTimers();assert.equal(f.commits.length,0,invalid);assert.equal(f.overlays.length,0);f.controller.destroy();assertDestroyed(f);
 }
});
test('explicit page-transfer opt-in captures normalized roots in document order and isolates predicate arguments from the callback',async()=>{
 const checked=[],selection=['extra','inside','source','source'],options={blockIds:selection,allowMultiPageTransfer:true,canDropOnPage:command=>{checked.push(structuredClone(command));command.blockIds.length=0;return true;}},f=fixture(null,options);
 f.blocks=[{id:'source',type:'columns',children:[{id:'left',type:'column',children:[{id:'inside',type:'paragraph',data:{text:'Inside'}}]},{id:'right',type:'column',children:[]}]},{id:'extra',type:'paragraph',data:{text:'Extra'}},{id:'target',type:'paragraph',data:{text:'Target'}}];const before=structuredClone(f.blocks);await f.controller.ready;
 const manager=f.managers[0];manager.prepare();const page=manager.droppables.find(item=>item.data.kind==='page');assert.equal(page.accept(manager.dragOperation.source),true);assert.deepEqual(checked[0],{blockId:'source',blockIds:['source','extra'],pageId:'page-b'});manager.start();manager.dragOperation.target=page;manager.dragOperation.position.current={x:100,y:20};manager.monitor.emit('dragover',{operation:manager.operation()});assert.equal(page.element.dataset.blockDrop,'page');
 manager.end({pageId:'page-b',point:{x:100,y:20}});assert.equal(f.crossPages.length,0);f.flushTimers();assert.deepEqual(f.crossPages,[{operation:{blockId:'source',blockIds:['source','extra'],pageId:'page-b'},phase:'cleaned'}]);assert.deepEqual(f.blocks,before);assert.deepEqual(selection,['extra','inside','source','source']);assert.equal(f.commits.length,0);f.controller.destroy();assertDestroyed(f);
});
test('opt-in single-block page drops publish a roots array while legacy callers retain their previous callback shape',async()=>{
 const f=fixture(null,{allowMultiPageTransfer:true});await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();manager.end({pageId:'page-b',point:{x:100,y:20}});f.flushTimers();assert.deepEqual(f.crossPages,[{operation:{blockId:'source',blockIds:['source'],pageId:'page-b'},phase:'cleaned'}]);f.controller.destroy();assertDestroyed(f);
});
test('opt-in page selection changes or normalization failures close acceptance, hover, drop and deferred commit',async()=>{
 for(const stage of ['pending','hover','drop','deferred'])for(const invalid of ['changed','missing','readonly']){
  const options={blockIds:['source','extra'],allowMultiPageTransfer:true},f=fixture(null,options);await f.controller.ready;const manager=f.managers[0];manager.prepare();const page=manager.droppables.find(item=>item.data.kind==='page');assert.equal(page.accept(manager.dragOperation.source),true);
  const change=()=>{if(invalid==='changed')options.blockIds=['source'];if(invalid==='missing')f.blocks=f.blocks.filter(block=>block.id!=='extra');if(invalid==='readonly')f.blocks.find(block=>block.id==='extra').data.purpose='import-source';};
  if(stage==='pending'){change();assert.equal(page.accept(manager.dragOperation.source),false);}manager.start();manager.dragOperation.target=page;manager.dragOperation.position.current={x:100,y:20};
  if(stage==='hover')change();manager.monitor.emit('dragover',{operation:manager.operation()});if(stage==='hover')assert.equal(page.element.dataset.blockDrop,undefined);
  if(stage==='drop')change();manager.end({pageId:'page-b',point:{x:100,y:20}});if(stage==='deferred')change();f.flushTimers();f.flushFrames();assert.equal(f.crossPages.length,0,stage+'/'+invalid);assert.equal(f.commits.length,0);assert.equal(f.overlays.length,0);f.controller.destroy();assertDestroyed(f);
 }
});
test('opt-in page ACL is rechecked at hover, drop and deferred callback and exceptions never open a review',async()=>{
 for(const stage of ['hover','drop','deferred'])for(const throwing of [false,true]){
  let allowed=true;const f=fixture(null,{blockIds:['source','extra'],allowMultiPageTransfer:true,canDropOnPage:()=>{if(!allowed&&throwing)throw Error('Revoked');return allowed;}});await f.controller.ready;const manager=f.managers[0];manager.prepare();const page=manager.droppables.find(item=>item.data.kind==='page');assert.equal(page.accept(manager.dragOperation.source),true);manager.start();manager.dragOperation.target=page;manager.dragOperation.position.current={x:100,y:20};
  if(stage==='hover')allowed=false;manager.monitor.emit('dragover',{operation:manager.operation()});if(stage==='hover')assert.equal(page.element.dataset.blockDrop,undefined);if(stage==='drop')allowed=false;manager.end({pageId:'page-b',point:{x:100,y:20}});if(stage==='deferred')allowed=false;f.flushTimers();f.flushFrames();assert.equal(f.crossPages.length,0,stage+'/'+throwing);assert.equal(f.status.textContent,'canceled');f.controller.destroy();assertDestroyed(f);
 }
});
test('old scopes and explicit selection cancellation suppress opt-in callbacks during initialization, dragging and SDK cleanup',async()=>{
 for(const stage of ['pending','active','deferred'])for(const cause of ['scope','selection-cancel']){
  const f=fixture(null,{blockIds:['source','extra'],allowMultiPageTransfer:true});await f.controller.ready;const manager=f.managers[0];manager.prepare();const invalidate=()=>{if(cause==='scope')f.scope='new-account:new-page';else f.controller.cancel();};if(stage==='pending')invalidate();manager.start();if(stage==='active')invalidate();manager.end({pageId:'page-b',point:{x:100,y:20}});if(stage==='deferred')invalidate();f.flushTimers();f.flushFrames();assert.equal(f.crossPages.length,0,stage+'/'+cause);assert.equal(f.overlays.length,0);f.controller.destroy();assertDestroyed(f);
 }
});
test('a page predicate may enable intact columns and refuse a page-bound attachment added after the drop',async()=>{
 for(const attached of [false,true]){
  let f;f=fixture(null,{blockIds:['source'],allowMultiPageTransfer:true,canDropOnPage:({blockIds})=>{planBlockForestMove(f.blocks,[],{blockIds,index:0});return true;}});f.blocks=[{id:'source',type:'columns',children:[{id:'left',type:'column',children:[{id:'inside',type:'paragraph',data:{text:'File'}}]},{id:'right',type:'column',children:[]}]},{id:'target',type:'paragraph',data:{text:'Target'}}];await f.controller.ready;const manager=f.managers[0];manager.prepare();assert.equal(manager.droppables.find(item=>item.data.kind==='page').accept(manager.dragOperation.source),true);manager.start();manager.end({pageId:'page-b',point:{x:100,y:20}});if(attached)f.blocks[0].children[0].children[0].data.links=[{attachmentId:'page-bound-file'}];f.flushTimers();assert.equal(f.crossPages.length,attached?0:1);if(!attached)assert.deepEqual(f.crossPages[0].operation.blockIds,['source']);f.controller.destroy();assertDestroyed(f);
 }
});

test('actual PointerSensor final moves may remain queued until up, while native release hit-testing still commits upward and downward',async t=>{
 const previous={window:globalThis.window,document:globalThis.document,requestAnimationFrame:globalThis.requestAnimationFrame},frames=[];
 globalThis.window={frameElement:null};globalThis.document={defaultView:null};globalThis.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
 t.after(()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
 const {PointerSensor}=await import('@dnd-kit/dom');
 for(const startY of [520,120]){
  const f=fixture();if(startY>250)f.blocks.reverse();f.source.rect.top=startY-20;await f.controller.ready;
  const manager=f.managers[0];manager.dragOperation.position.current={x:300,y:startY};manager.prepare();manager.start();
  manager.dragOperation.status={idle:false,initialized:true,initializing:false,dragging:true};let moves=0;
  manager.actions.move=({to})=>{moves++;manager.dragOperation.position.current={...to};};
  manager.actions.stop=({event,canceled})=>manager.end({canceled,point:{...manager.dragOperation.position.current},targetId:'source',nativeEvent:event});
  f.doc.elementFromPoint=()=>f.target.querySelector('[data-block-drag-handle]');
  const sensor=new PointerSensor(manager),event={type:'pointermove',clientX:300,clientY:250,preventDefault(){},stopPropagation(){}};
  sensor.handlePointerMove(event,{element:null});sensor.handlePointerUp({...event,type:'pointerup',target:null});
  for(const callback of frames.splice(0))callback();assert.equal(moves,0,'actual package clears the still-queued final move during pointerup');
  assert.equal(f.commits.length,0);f.flushTimers();assert.deepEqual(f.commits,[{operation:{blockId:'source',targetId:'target',placement:'inside'},phase:'cleaned'}]);
  sensor.destroy();f.controller.destroy();assertDestroyed(f);
 }
});

test('a pointer release uses the current physical hit and latest tree rather than its prior collision target',async()=>{
 for(const oldTarget of [null,'source']){
  const f=fixture();await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();
  f.doc.elementFromPoint=(x,y)=>{assert.deepEqual({x,y},{x:300,y:250});return f.target.querySelector('[data-block-drag-handle]');};
  manager.end({point:{x:300,y:120},targetId:oldTarget,nativeEvent:{type:'pointerup',clientX:300,clientY:250,target:f.doc.body,view:f.win}});
  f.flushTimers();assert.equal(f.commits.length,1);assert.equal(f.commits[0].operation.placement,'inside');assert.deepEqual(manager.dragOperation.position.current,{x:300,y:120},'snapshot coordinates are not rewritten');f.controller.destroy();assertDestroyed(f);
 }
});

test('pointer release cancels outside, inert, modal, missing or opaque hits without falling back to a stale accepted target',async()=>{
 for(const scenario of ['outside','missing','throwing','no-hit-test','inert','modal','shadow-host','custom-host','other-window','other-document','scope','readonly','canceled','pointercancel','missing-pointerup']){
  const f=fixture();await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();
  const nativeEvent={type:'pointerup',clientX:300,clientY:250,target:f.doc.body,view:f.win};f.doc.elementFromPoint=()=>f.target;
  if(scenario==='outside')f.doc.elementFromPoint=()=>f.doc.body;
  if(scenario==='missing')f.doc.elementFromPoint=()=>null;
  if(scenario==='throwing')f.doc.elementFromPoint=()=>{throw Error('No hit');};
  if(scenario==='no-hit-test')delete f.doc.elementFromPoint;
  if(scenario==='inert')f.target.inert=true;
  if(scenario==='modal')f.doc.querySelector=selector=>selector==='dialog[open]'?{}:null;
  if(scenario==='shadow-host')f.target.shadowRoot={};
  if(scenario==='custom-host')f.target.localName='opaque-embed';
  if(scenario==='other-window')nativeEvent.view={};
  if(scenario==='other-document')nativeEvent.target={ownerDocument:{}};
  if(scenario==='scope')f.scope='new:page';
  if(scenario==='readonly')f.blocks.find(block=>block.id==='source').data.purpose='import-source';
  if(scenario==='pointercancel')nativeEvent.type='pointercancel';
  if(scenario==='missing-pointerup')manager.dragOperation.activatorEvent={type:'pointermove'};
  manager.end({point:{x:300,y:250},nativeEvent:scenario==='missing-pointerup'?undefined:nativeEvent,canceled:scenario==='canceled'});f.flushTimers();f.flushFrames();
  assert.equal(f.commits.length,0,scenario);assert.equal(f.crossPages.length,0,scenario);assert.equal(f.status.textContent,'canceled',scenario);f.controller.destroy();assertDestroyed(f);
 }
});

test('an invalid nearest registered target never falls through to an eligible ancestor row',async()=>{
 const f=fixture();f.source.remove();f.target.append(f.source);f.source.rect={...f.target.rect};await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();
 f.doc.elementFromPoint=()=>f.source.querySelector('[data-block-drag-handle]');
 manager.end({nativeEvent:{type:'pointerup',clientX:300,clientY:250}});f.flushTimers();assert.equal(f.commits.length,0);assert.equal(f.status.textContent,'canceled');f.controller.destroy();assertDestroyed(f);
});

test('fresh pointer hits retain column nesting, root-end and sidebar page destinations',async()=>{
 for(const kind of ['column','end','page']){
  const f=fixture();if(kind==='column')f.blocks=[{id:'source',type:'paragraph',data:{text:'Source'}},{id:'layout',type:'columns',children:[{id:'target',type:'column',children:[]},{id:'other-column',type:'column',children:[]}]}];
  await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();const target=manager.droppables.find(item=>kind==='column'?item.data.blockId==='target':item.data.kind===kind);
  f.doc.elementFromPoint=()=>target.element;const point=kind==='column'?{x:300,y:250}:{x:100,y:20};
  manager.end({point:{x:300,y:120},targetId:'source',nativeEvent:{type:'pointerup',clientX:point.x,clientY:point.y}});f.flushTimers();
  if(kind==='page'){assert.equal(f.commits.length,0);assert.deepEqual(f.crossPages,[{operation:{blockId:'source',pageId:'page-b'},phase:'cleaned'}]);}
  else{assert.equal(f.crossPages.length,0);assert.deepEqual(f.commits,[{operation:{blockId:'source',targetId:kind==='end'?null:'target',placement:kind==='end'?'end':'inside'},phase:'cleaned'}]);}
  f.controller.destroy();assertDestroyed(f);
 }
});

test('pointer hit acceptance, geometry and policy are rechecked again before a deferred callback',async()=>{
 for(const scenario of ['disabled-page','page-policy','out-of-geometry','selection-changed','late-readonly']){
  let allowed=true;const options={blockIds:['source','extra'],allowMultiPageTransfer:true,canDropOnPage:()=>allowed},f=fixture(null,options);await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();
  const page=manager.droppables.find(item=>item.data.kind==='page');f.doc.elementFromPoint=()=>scenario==='late-readonly'?f.target:page.element;
  if(scenario==='disabled-page')page.element.disabled=true;
  if(scenario==='page-policy')allowed=false;
  if(scenario==='selection-changed')options.blockIds=['source'];
  const point=scenario==='late-readonly'?{x:300,y:250}:scenario==='out-of-geometry'?{x:900,y:700}:{x:100,y:20};
  manager.end({nativeEvent:{type:'pointerup',clientX:point.x,clientY:point.y}});if(scenario==='late-readonly')f.blocks.find(block=>block.id==='target').data.purpose='import-source';f.flushTimers();
  assert.equal(f.commits.length,0,scenario);assert.equal(f.crossPages.length,0,scenario);f.controller.destroy();assertDestroyed(f);
 }
});

test('keyboard drops preserve their existing virtual coordinates and never attempt physical pointer hit-testing',async()=>{
 const f=fixture();await f.controller.ready;const manager=f.managers[0];manager.prepare();manager.start();manager.dragOperation.activatorEvent={type:'keydown'};f.doc.elementFromPoint=()=>{assert.fail('Keyboard drop must not hit-test a physical pointer.');};
 manager.end({nativeEvent:{type:'keydown',code:'Space'}});f.flushTimers();assert.equal(f.commits.length,1);assert.equal(f.commits[0].operation.placement,'inside');f.controller.destroy();assertDestroyed(f);
});
