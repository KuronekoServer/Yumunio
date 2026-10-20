import test from 'node:test';
import assert from 'node:assert/strict';
import {bindMotionDialog} from '../public/motion-dialog-controller.js';
import {settingsDomFixture} from './fixtures/settings-dom.js';

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture(t) {
  const f = settingsDomFixture(t);
  const dialog = f.doc.createElement('dialog');
  const input = f.doc.createElement('input');
  dialog.append(input);
  f.doc.body.append(dialog);
  const close = dialog.close;
  dialog.close = value => { close(); dialog.returnValue = value ?? ''; };
  const originalShow = dialog.showModal;
  const originalClose = dialog.close;
  const shades = [];
  const animations = [];
  let reduced = false;
  let composing = false;
  const binding = bindMotionDialog({
    dialog,
    isReducedMotion: () => reduced,
    isComposing: () => composing,
    onShade: value => shades.push(value),
    animate(element, values, transition) {
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const control = {
        element, values, transition, stopped: false,
        stop() { this.stopped = true; },
        complete() { finish(); },
        then: done.then.bind(done)
      };
      animations.push(control);
      return control;
    }
  });
  t.after(() => binding.destroy());
  return {...f, dialog, input, binding, shades, animations, originalShow, originalClose,
    cancel() {
      const event = new Event('cancel', {cancelable: true});
      for (const listener of dialog.listeners.get('cancel')) listener(event);
      return event;
    },
    setReduced(value) { reduced = value; }, setComposing(value) { composing = value; }};
}

test('dialog keeps native modality until exit completes, then restores focus and return value', async t => {
  const f = fixture(t);
  // The fixture does not emulate native focus restoration; the controller must do it.
  f.dialog.showModal();
  assert.equal(f.dialog.open, true);
  assert.equal(f.animations[0].transition.duration, .16);
  f.input.focus();
  f.dialog.close('saved');
  assert.equal(f.dialog.open, true);
  assert.equal(f.dialog.inert, true);
  assert.equal(f.doc.activeElement, f.input);
  f.animations.at(-1).complete();
  await flush();
  assert.equal(f.dialog.open, false);
  assert.equal(f.dialog.inert, false);
  assert.equal(f.doc.activeElement, f.trigger);
  assert.deepEqual(f.shades, [{kind: 'modal'}, null]);
  assert.equal(f.dialog.returnValue, 'saved');
});

test('a cancelled exit cannot close a newly opened view or clear its background', async t => {
  const f = fixture(t);
  f.dialog.showModal();
  f.dialog.close();
  const previousExit = f.animations.at(-1);
  f.dialog.closeImmediately();
  f.dialog.dataset.motionKind = 'menu';
  f.dialog.showModal();
  f.dialog.dispatch('close');
  previousExit.complete();
  await flush();
  assert.equal(previousExit.stopped, true);
  assert.equal(f.dialog.open, true);
  assert.deepEqual(f.shades.at(-1), {kind: 'menu'});
  assert.equal(f.animations.at(-1).transition.duration, .12);
});

test('a removed menu action returns focus to its persistent sidebar trigger', async t => {
  const f = fixture(t);
  const menu = f.doc.createElement('div');
  menu.className = 'motion-sidebar-menu';
  const trigger = f.doc.createElement('button');
  trigger.className = 'sidebar-menu-trigger';
  const action = f.doc.createElement('button');
  menu.append(trigger, action);
  f.doc.body.append(menu);
  action.focus();
  f.dialog.showModal();
  f.input.focus();
  action.remove();
  f.dialog.close();
  f.animations.at(-1).complete();
  await flush();
  assert.equal(f.doc.activeElement, trigger);
});

test('a different control focused during exit keeps its focus', async t => {
  const f = fixture(t);
  f.dialog.showModal();
  f.input.focus();
  f.dialog.close();
  f.editor.focus();
  f.animations.at(-1).complete();
  await flush();
  assert.equal(f.doc.activeElement, f.editor);
});

test('Escape honors composition and existing busy guards', async t => {
  const f = fixture(t);
  f.dialog.showModal();
  let busy = true;
  f.dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  await flush();
  f.cancel();
  assert.equal(f.dialog.inert, false, 'an existing guard must run before the animated close');
  busy = false;
  f.setComposing(true);
  f.cancel();
  assert.equal(f.dialog.inert, false);
  f.setComposing(false);
  f.cancel();
  assert.equal(f.dialog.inert, true);
});

test('reduced motion can finish a pending exit and all native methods are restored on teardown', async t => {
  const f = fixture(t);
  f.dialog.showModal();
  f.dialog.close();
  f.setReduced(true);
  f.binding.finish();
  await flush();
  assert.equal(f.dialog.open, false);
  f.dialog.showModal();
  assert.equal(f.animations.at(-1).transition.duration, 0);
  assert.equal(f.animations.at(-1).values.y, 0);
  f.binding.destroy();
  await flush();
  assert.equal(f.dialog.open, false);
  assert.equal(f.dialog.showModal, f.originalShow);
  assert.equal(f.dialog.close, f.originalClose);
  assert.equal(f.dialog.closeImmediately, undefined);
  assert.equal(f.dialog.listeners.get('cancel').length, 0);
});
