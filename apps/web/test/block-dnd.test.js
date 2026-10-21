import test from 'node:test';
import assert from 'node:assert/strict';

test('horizontal edge projections create explicit column destinations only when supported',()=>{
 const blocks=[{id:'moving',type:'paragraph',data:{text:'moving'}},{id:'target',type:'paragraph',data:{text:'target'}}],rect={left:100,top:200,width:400,height:100},input={blocks,blockId:'moving',targetId:'target',rect,point:{x:495,y:250}};
 assert.equal(projectBlockDrop({...input,allowColumns:true}).placement,'right');assert.equal(projectBlockDrop({...input,allowColumns:true,point:{x:105,y:250}}).placement,'left');assert.notEqual(projectBlockDrop(input)?.placement,'right');assert.equal(validateBlockDrop({...input,placement:'left'}),null);assert.equal(validateBlockDrop({...input,allowColumns:true,placement:'left'}).placement,'left');assert.deepEqual(blocks.map(block=>block.id),['moving','target']);
});
import { projectBlockDrop, validateBlockDrop } from '../public/block-dnd.js';
import { moveEditorBlockTo, indexEditorBlocks, MAX_EDITOR_NESTING } from '../public/editor-tree.js';

const block = (id, extra = {}) => ({ id, type: 'paragraph', data: { text: id }, ...extra });
const rect = { left: 100, top: 200, right: 400, bottom: 300, width: 300, height: 100 };
const operation = (blockId, targetId, placement) => ({ blockId, targetId, placement });

test('pointer projection distinguishes sibling insertion and nesting without moving the draft', () => {
  const blocks = [block('moving'), block('spacer'), block('parent', { children: [block('existing')] })];
  const original = structuredClone(blocks);
  for (const [y, placement] of [[205, 'before'], [250, 'inside'], [295, 'after']]) {
    assert.deepEqual(projectBlockDrop({ blocks, blockId: 'moving', targetId: 'parent', rect, point: { x: 160, y } }),
      operation('moving', 'parent', placement));
  }
  blocks[2].type = 'code';
  assert.deepEqual(projectBlockDrop({ blocks, blockId: 'moving', targetId: 'parent', rect, point: { x: 160, y: 240 } }),
    operation('moving', 'parent', 'before'));
  assert.deepEqual(projectBlockDrop({ blocks, blockId: 'moving', targetId: 'parent', rect, point: { x: 160, y: 260 } }),
    operation('moving', 'parent', 'after'));
  blocks[2].type = 'paragraph';
  assert.deepEqual(blocks, original);
});

test('pointer projection requires a finite visible hit in both dimensions', () => {
  const blocks = [block('moving'), block('spacer'), block('target')];
  const input = { blocks, blockId: 'moving', targetId: 'target', rect, point: { x: 160, y: 250 } };
  for (const point of [{ x: 99, y: 250 }, { x: 401, y: 250 }, { x: 160, y: 199 }, { x: 160, y: 301 },
    { x: NaN, y: 250 }, { x: 160, y: Infinity }, null]) {
    assert.equal(projectBlockDrop({ ...input, point }), null);
  }
  for (const bounds of [{ ...rect, height: 0 }, { ...rect, width: 0 }, { ...rect, top: NaN },
    { ...rect, left: Infinity }, { ...rect, height: -1 }, null]) {
    assert.equal(projectBlockDrop({ ...input, rect: bounds }), null);
  }
});

test('explicit keyboard destinations and root end use the same move rules without pointer geometry', () => {
  const blocks = [block('parent', { children: [block('moving')] }), block('target')];
  for (const placement of ['before', 'after', 'inside']) {
    assert.deepEqual(projectBlockDrop({ blocks, blockId: 'moving', targetId: 'target', placement }),
      operation('moving', 'target', placement));
  }
  assert.deepEqual(projectBlockDrop({ blocks, blockId: 'moving' }), operation('moving', null, 'end'));
  assert.deepEqual(validateBlockDrop({ blocks, blockId: 'moving', targetId: null, placement: 'end' }),
    operation('moving', null, 'end'));
  assert.equal(validateBlockDrop({ blocks, blockId: 'moving', targetId: 'target', placement: 'end' }), null);
});

test('same-position drops do not create reorder or nesting commands', () => {
  const blocks = [block('a'), block('b'), block('parent', { children: [block('first'), block('last')] })];
  for (const input of [operation('a', 'b', 'before'), operation('b', 'a', 'after'),
    operation('parent', null, 'end'), operation('last', 'parent', 'inside'), operation('first', 'last', 'before'),
    operation('last', 'first', 'after')]) {
    assert.equal(validateBlockDrop({ blocks, ...input }), null);
    assert.equal(projectBlockDrop({ blocks, ...input }), null);
  }
  assert.deepEqual(validateBlockDrop({ blocks, blockId: 'a', targetId: 'b', placement: 'after' }),
    operation('a', 'b', 'after'));
});

test('cross-parent drop preserves the complete subtree and the latest text formatting and references', () => {
  const moving = block('moving', { data: { text: 'A\u{1f600}B', marks: [{ start: 1, end: 3, styles: ['bold'] }],
    links: [{ start: 3, end: 4, label: 'B', pageId: 'page-b' }] },
    children: [block('source', { type: 'code', data: { text: 'Original source', purpose: 'import-source', source: { preserved: true } } })] });
  const blocks = [block('old', { children: [moving] }), block('new', { children: [block('existing')] })];
  const original = structuredClone(blocks);
  const projected = projectBlockDrop({ blocks, blockId: 'moving', targetId: 'existing', placement: 'before' });
  assert.deepEqual(projected, operation('moving', 'existing', 'before'));
  moving.data.text += ' latest';
  const validated = validateBlockDrop({ blocks, ...projected });
  assert.deepEqual(validated, projected);
  const result = moveEditorBlockTo(blocks, validated);
  assert.deepEqual(result[1].children.map(item => item.id), ['moving', 'existing']);
  assert.deepEqual(result[1].children[0], moving);
  assert.deepEqual(result[0].children, []);
  assert.equal(indexEditorBlocks(result).size, indexEditorBlocks(blocks).size);
  assert.deepEqual(original[0].children[0].data.text, 'A\u{1f600}B');
  assert.deepEqual(blocks[0].children[0], moving);
});

test('commit validation rejects targets invalidated after the drag preview', () => {
  const initial = [block('moving', { children: [block('child')] }), block('target')];
  const projected = projectBlockDrop({ blocks: initial, blockId: 'moving', targetId: 'target', placement: 'inside' });
  assert.deepEqual(projected, operation('moving', 'target', 'inside'));
  const deleted = structuredClone(initial); deleted.pop();
  const noLongerParent = structuredClone(initial); noLongerParent[1].type = 'code';
  const readOnly = structuredClone(initial); readOnly[1].data.purpose = 'import-source';
  const nowDescendant = structuredClone(initial); nowDescendant[0].children.push(nowDescendant.pop());
  for (const blocks of [deleted, noLongerParent, readOnly, nowDescendant]) {
    const original = structuredClone(blocks);
    assert.equal(validateBlockDrop({ blocks, ...projected }), null);
    assert.deepEqual(blocks, original);
  }
});

test('invalid identities, cycles, readonly ancestry and malformed trees never become drop commands', () => {
  const blocks = [block('parent', { children: [block('child')] }), block('moving'),
    block('raw', { type: 'code', data: { text: 'Source', purpose: 'import-source' }, children: [block('raw-child')] })];
  const original = structuredClone(blocks);
  for (const input of [operation('parent', 'parent', 'after'), operation('parent', 'child', 'before'),
    operation('parent', 'child', 'inside'), operation('missing', 'moving', 'before'), operation('moving', 'missing', 'after'),
    operation('raw', null, 'end'), operation('raw-child', null, 'end'), operation('moving', 'raw-child', 'before'),
    operation('moving', 'raw', 'inside'), operation('moving', 'parent', 'unknown')]) {
    assert.equal(validateBlockDrop({ blocks, ...input }), null);
  }
  for (const invalid of [null, {}, [block('duplicate'), block('duplicate')], [block('bad', { children: {} })]]) {
    assert.equal(validateBlockDrop({ blocks: invalid, blockId: 'moving', targetId: null, placement: 'end' }), null);
  }
  assert.deepEqual(blocks, original);
});

test('nesting accepts the deepest legal leaf but refuses a subtree that would exceed the depth limit', () => {
  const parent = block('depth-0'); let cursor = parent;
  for (let depth = 1; depth < MAX_EDITOR_NESTING; depth++) {
    cursor.children = [block('depth-' + depth)]; cursor = cursor.children[0];
  }
  const blocks = [parent, block('leaf'), block('branch', { children: [block('tip')] })];
  const original = structuredClone(blocks);
  assert.deepEqual(validateBlockDrop({ blocks, blockId: 'leaf', targetId: 'depth-6', placement: 'inside' }),
    operation('leaf', 'depth-6', 'inside'));
  assert.equal(validateBlockDrop({ blocks, blockId: 'leaf', targetId: 'depth-7', placement: 'inside' }), null);
  assert.equal(validateBlockDrop({ blocks, blockId: 'branch', targetId: 'depth-6', placement: 'inside' }), null);
  assert.deepEqual(blocks, original);
});

test('flat local editors keep center hits as sibling moves and reject explicit nesting again at commit', () => {
  const blocks = [block('moving'), block('spacer'), block('target')], original = structuredClone(blocks);
  const input = { blocks, blockId: 'moving', targetId: 'target', rect, allowInside: false };
  for (const [y, placement] of [[200, 'before'], [240, 'before'], [250, 'after'], [260, 'after'], [300, 'after']]) {
    const projected = projectBlockDrop({ ...input, point: { x: 160, y } });
    assert.deepEqual(projected, operation('moving', 'target', placement));
    assert.deepEqual(validateBlockDrop({ blocks, ...projected, allowInside: false }), projected);
    assert.ok(moveEditorBlockTo(blocks, projected).every(item => !item.children?.length));
  }
  const nested = operation('moving', 'target', 'inside');
  assert.deepEqual(projectBlockDrop({ blocks, ...nested }), nested, 'server pages still allow nesting by default');
  assert.equal(projectBlockDrop({ blocks, ...nested, allowInside: false }), null);
  assert.equal(validateBlockDrop({ blocks, ...nested, allowInside: false }), null);
  assert.equal(projectBlockDrop({ ...input, point: { x: 160, y: 199 } }), null);
  assert.deepEqual(blocks, original);
});


test('opt-in selected forest projection preserves document order and rejects its own selected subtree',()=>{
 const blocks=[block('a',{children:[block('a-child')]}),block('b'),block('target')],before=structuredClone(blocks);
 const projected=projectBlockDrop({blocks,blockId:'a-child',blockIds:['b','a-child','a'],targetId:'target',placement:'inside'});
 assert.deepEqual(projected,{blockId:'a-child',blockIds:['a','b'],targetId:'target',placement:'inside'});
 assert.deepEqual(validateBlockDrop({blocks,...projected}),projected);
 for(const targetId of ['a','a-child','b'])assert.equal(validateBlockDrop({blocks,blockId:'a',blockIds:['a','b'],targetId,placement:'before'}),null);
 assert.equal(projectBlockDrop({blocks,blockId:'target',blockIds:['a','b'],targetId:'a-child',placement:'before'}),null,'a handle cannot drag an unrelated selection');
 assert.deepEqual(blocks,before);
});

test('selected forest drop rejects no-op, readonly invalidation and a missing selected root at commit',()=>{
 const blocks=[block('a'),block('b'),block('target')],operation={blockId:'a',blockIds:['a','b'],targetId:'target',placement:'inside'};
 assert.ok(validateBlockDrop({blocks,...operation}));
 assert.equal(projectBlockDrop({blocks,...operation,placement:'before'}),null,'contiguous group already precedes the target');
 blocks[1].data.purpose='import-source';assert.equal(validateBlockDrop({blocks,...operation}),null);
 delete blocks[1].data.purpose;blocks.splice(1,1);assert.equal(validateBlockDrop({blocks,...operation}),null);
});
