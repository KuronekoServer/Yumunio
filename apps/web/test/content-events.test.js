import test from 'node:test';
import assert from 'node:assert/strict';
import {createContentNotifications} from '../public/content-events.js';

function fixture(t) {
  const view = new EventTarget();
  const received = [];
  const channels = [];
  class Channel extends EventTarget {
    constructor(name) { super(); this.name = name; this.sent = []; channels.push(this); }
    close() { this.closed = true; }
    postMessage(value) { if (this.closed || this.blocked) throw Error('Unavailable'); this.sent.push(value); }
    receive(data) { const event = new Event('message'); event.data = data; this.dispatchEvent(event); }
  }
  view.addEventListener('yumunio:content-changed', event => received.push(event.detail));
  const notifications = createContentNotifications(view, Channel);
  t.after(() => notifications.destroy());
  return {view, notifications, channels, received};
}
const change = {workspaceId: 'workspace-a', accountId: 'owner', revision: 4};

test('returning from browser history reconnects cross-tab notifications', t => {
  const f = fixture(t);
  f.view.dispatchEvent(new Event('pagehide'));
  assert.equal(f.channels[0].closed, true);
  f.view.dispatchEvent(new Event('pageshow'));
  assert.equal(f.channels.length, 2);
  f.channels[0].receive({type: 'content-changed', ...change});
  assert.equal(f.received.length, 0);
  f.channels[1].receive({type: 'content-changed', ...change, content: 'must not be forwarded'});
  assert.deepEqual(f.received, [{type: 'content-changed', ...change,remote:true}]);
  f.notifications.notify({...change, revision: 5});
  assert.equal(f.channels[1].sent[0].revision, 5);
});

test('a failed cross-tab broadcast still delivers the local save notification', t => {
  const f = fixture(t);
  f.channels[0].blocked = true;
  assert.doesNotThrow(() => f.notifications.notify(change));
  assert.equal(f.received.length, 1);
  assert.equal(f.channels[0].closed, true);
  f.notifications.notify({...change, revision: 5});
  assert.equal(f.channels.length, 2);
  assert.equal(f.received[1].revision, 5);
});

test('malformed messages and disposed listeners cannot refresh or reopen a channel', t => {
  const f = fixture(t);
  for (const value of [{type: 'other', ...change}, {type: 'content-changed', ...change, revision: -1}, {type: 'content-changed', revision: 2}]) f.channels[0].receive(value);
  assert.equal(f.received.length, 0);
  f.notifications.destroy();
  f.channels[0].receive({type: 'content-changed', ...change});
  f.view.dispatchEvent(new Event('pageshow'));
  f.notifications.notify(change);
  assert.equal(f.channels.length, 1);
  assert.equal(f.received.length, 0);
});
