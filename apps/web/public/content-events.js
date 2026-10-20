const validChange = value => value?.type === 'content-changed' &&
  typeof value.workspaceId === 'string' && typeof value.accountId === 'string' &&
  Number.isSafeInteger(value.revision) && value.revision >= 0;

/** Notifications carry identifiers only; subscribers still perform authorized reads. */
export function createContentNotifications(view, Channel = globalThis.BroadcastChannel) {
  let channel = null;
  let disposed = false;

  function emit(value) {
    const detail = {
      type: 'content-changed', workspaceId: value.workspaceId,
      accountId: value.accountId, revision: value.revision
    };
    view.dispatchEvent(new CustomEvent('yumunio:content-changed', {detail}));
  }

  function disconnect() {
    try { channel?.close(); } catch {}
    channel = null;
  }

  function connect() {
    if (disposed || channel || typeof Channel !== 'function') return;
    try {
      const peer = new Channel('yumunio-content');
      channel = peer;
      peer.addEventListener('message', event => {
        if (!disposed && channel === peer && validChange(event.data)) emit(event.data);
      });
    } catch {
      channel = null;
    }
  }

  connect();
  view.addEventListener('pagehide', disconnect);
  view.addEventListener('pageshow', connect);

  return {
    notify({workspaceId, accountId, revision}) {
      const value = {type: 'content-changed', workspaceId, accountId, revision};
      if (disposed || !validChange(value)) return;
      connect();
      try { channel?.postMessage(value); } catch { disconnect(); }
      // Broadcast failure must not interrupt a successful save or local refresh.
      emit(value);
    },
    destroy() {
      disposed = true;
      disconnect();
      view.removeEventListener('pagehide', disconnect);
      view.removeEventListener('pageshow', connect);
    }
  };
}

const notifications = typeof window === 'undefined' ? null : createContentNotifications(window);
export function notifyContentChange(change) { notifications?.notify(change); }
