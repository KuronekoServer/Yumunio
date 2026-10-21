import {requestMotionSurface} from './motion-bridge.js';
import {createRecordPanelDom} from './record-panel-dom.js';

const EMPTY_FRAME_RETRY_MS = 5000;
const DETAIL_TIMEOUT_MS = 20000;

/**
 * Coordinates saving, permission loss and focus independently of rendering.
 * A surface exposes host/frame/exit/full, feedback and retry methods, optional
 * asynchronous close(), and immediate destroy(). It never owns document data.
 */
export function createRecordPanel({
  document = globalThis.document,
  window = globalThis.window,
  workspaceId,
  getAccountId,
  prepare = async () => true,
  onChanged = () => {},
  onClosed = () => {},
  t,
  signal,
  renderSurface = model => requestMotionSurface('record', model, window)
}) {
  let active = null;
  let generation = 0;
  let closing = null;
  const lifetime = new AbortController();
  const pending = new Map();
  const listen = (target, event, fn) => target.addEventListener(event, fn, {signal: lifetime.signal});

  function state() {
    return active ? {
      pageId: active.record.pageId,
      collectionId: active.collectionId,
      dirty: active.dirty,
      busy: active.busy
    } : null;
  }

  function send(data) {
    active?.frame.contentWindow?.postMessage({
      ...data, workspaceId, accountId: getAccountId(), pageId: active.record.pageId
    }, window.location.origin);
  }

  function stopNavigationTimers(current) {
    for (const timer of current?.navigationTimers ?? []) clearTimeout(timer);
    if (current) current.navigationTimers = [];
  }

  function destroy() {
    generation++;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    pending.clear();
    stopNavigationTimers(active);
    active?.surface.destroy();
    active = null;
    document.body.classList.remove('record-panel-open');
  }

  function restoreFocus(previous) {
    if (!previous) return;
    const focused = document.activeElement;
    // Do not steal focus if the user started another operation during the exit.
    if (focused && focused !== document.body && focused !== previous.frame && !previous.host.contains(focused)) return;
    const row = [...(previous.focusRoot?.querySelectorAll('[data-record-id]') ?? [])]
      .find(row => row.dataset.recordId === previous.record.id);
    const target = previous.focus?.isConnected ? previous.focus : ['BUTTON','A'].includes(row?.nodeName) ? row : row?.querySelector('button,a');
    target?.focus({preventScroll: true});
  }

  function remove() {
    const previous = active;
    destroy();
    if (previous) {
      onClosed(previous.record);
      restoreFocus(previous);
    }
  }

  function prepareToClose() {
    const requestId = globalThis.crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(false);
      }, DETAIL_TIMEOUT_MS);
      pending.set(requestId, {resolve, timer});
      send({type: 'yumunio:detail-prepare', requestId});
    });
  }

  async function finishClose(current, {fullPage}) {
    stopNavigationTimers(current);
    document.body.classList.remove('record-panel-open');
    await current.surface.close?.();
    if (active !== current) return false;
    const href = current.full.href;
    remove();
    if (fullPage) window.location.assign(href);
    return true;
  }

  async function close({fullPage = false} = {}) {
    if (closing) return closing;
    if (!active) return true;
    const current = active;
    closing = (async () => {
      if (current.ready) {
        const accepted = await prepareToClose();
        if (!accepted || active !== current) return false;
      }
      return finishClose(current, {fullPage});
    })();
    try {
      return await closing;
    } finally {
      closing = null;
    }
  }

  function watchInitialNavigation(current) {
    current.navigationTimers = [
      setTimeout(() => {
        if (active !== current || current.ready) return;
        try {
          const source = current.frame.contentDocument;
          // Only an untouched initial blank document may be replaced. Never
          // reload a loaded editor, including one with unsaved input.
          if (source?.URL === 'about:blank' && source.body?.childNodes.length === 0) {
            current.frame = current.surface.retryFrame();
          }
        } catch {
          // An inaccessible document is excluded from retries as well.
        }
      }, EMPTY_FRAME_RETRY_MS),
      setTimeout(() => {
        if (active !== current || current.ready) return;
        const text = t('detailPanel.loadFailed');
        current.surface.setStatus(text, text);
      }, DETAIL_TIMEOUT_MS)
    ];
  }

  async function open(record, collectionId) {
    const started=performance.now();
    if (closing) await closing;
    if (active?.record.pageId === record.pageId) {
      active.frame.focus();
      return true;
    }
    if (active && !await close()) return false;

    const marker = ++generation;
    const accountId = getAccountId();
    const focus = document.activeElement;
    const focusRoot = focus?.closest?.('.database-placement') ??
      focus?.closest?.('.collection-projection') ?? document;
    if (!accountId || !await prepare(record, collectionId) ||
        marker !== generation || getAccountId() !== accountId) return false;

    const fullUrl = '/workspace?' + new URLSearchParams({workspace: workspaceId, page: record.pageId});
    const editor = new URL(fullUrl, window.location.origin);
    editor.pathname = '/workspace-detail';
    editor.searchParams.set('detail', '1');
    if (collectionId) {
      editor.searchParams.set('record', record.id);
      editor.searchParams.set('collection', collectionId);
    } else {
      editor.searchParams.set('synced', '1');
    }
    const model = {
      title: t('detailPanel.title'),
      closeLabel: t('detailPanel.close'),
      fullPageLabel: t('detailPanel.fullPage'),
      editorTitle: t('detailPanel.editor', {name: record.title}),
      loading: t('loading'),
      fullUrl,
      editorUrl: editor.href,
      onClose: () => void close(),
      onFullPage(event) {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void close({fullPage: true});
      }
    };
    const surface = renderSurface(model) ?? createRecordPanelDom(document, model);
    const {host, frame, full} = surface;
    active = {
      surface, host, frame, full, record, collectionId, focus, focusRoot, accountId,
      dirty: false, busy: true, revision: null,started
    };
    document.body.classList.add('record-panel-open');
    watchInitialNavigation(active);
    surface.exit.focus({preventScroll: true});
    return true;
  }

  listen(window, 'message', event => {
    const data = event.data;
    const current = active;
    // Every frame notification is fenced by both its browsing context and actor.
    if (!current || event.origin !== window.location.origin || event.source !== current.frame.contentWindow ||
        data?.workspaceId !== workspaceId || data.accountId !== getAccountId() ||
        data.accountId !== current.accountId || data.pageId !== current.record.pageId) return;

    if (data.type === 'yumunio:detail-ready' && typeof data.dirty === 'boolean' && typeof data.busy === 'boolean') {
      stopNavigationTimers(current);
      current.ready = true;
      if(!current.host.dataset.readyMs)current.host.dataset.readyMs=String(Math.round(performance.now()-current.started));
      current.dirty = data.dirty;
      current.busy = data.busy;
      current.surface.setStatus('');
      if (Number.isSafeInteger(data.revision) && data.revision >= 0 && current.revision !== data.revision) {
        current.revision = data.revision;
        void onChanged(current.record, data.revision);
      }
    }
    if (data.type === 'yumunio:detail-close') void close();
    if (data.type === 'yumunio:detail-access-lost') remove();
    if (data.type === 'yumunio:detail-prepared' && typeof data.accepted === 'boolean') {
      const entry = pending.get(data.requestId);
      if (entry) {
        pending.delete(data.requestId);
        clearTimeout(entry.timer);
        entry.resolve(data.accepted);
      }
    }
  });

  listen(window, 'keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing &&
        event.keyCode !== 229 && active && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      void close();
    }
  });
  listen(window, 'beforeunload', event => {
    if (active && (active.dirty || active.busy)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  signal?.addEventListener('abort', () => {
    destroy();
    lifetime.abort();
  }, {once: true});
  return {open, close, destroy, state};
}
