/** DOM fallback for hosts without the React motion provider. */
export function createRecordPanelDom(document, model) {
  const host = document.createElement('aside');
  host.className = 'record-detail-panel';
  host.setAttribute('aria-label', model.title);
  host.setAttribute('role', 'region');

  const header = document.createElement('header');
  header.className = 'record-detail-header';
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'button quiet';
  exit.textContent = model.closeLabel;
  exit.addEventListener('click', model.onClose);
  const full = document.createElement('a');
  full.className = 'button quiet';
  full.href = model.fullUrl;
  full.textContent = model.fullPageLabel;
  full.addEventListener('click', model.onFullPage);
  const status = document.createElement('span');
  status.className = 'record-detail-status';
  status.setAttribute('role', 'status');
  status.textContent = model.loading;

  function createFrame() {
    const next = document.createElement('iframe');
    next.className = 'record-detail-frame';
    next.title = model.editorTitle;
    next.referrerPolicy = 'same-origin';
    return next;
  }
  let frame = createFrame();
  header.append(exit, status, full);
  host.append(header, frame);
  document.body.append(host);
  frame.src = model.editorUrl;

  return {
    host, exit, full, status,
    get frame() { return frame; },
    setStatus(text, title = '') {
      status.textContent = text;
      status.title = title;
    },
    retryFrame() {
      frame.remove();
      frame = createFrame();
      host.append(frame);
      frame.src = model.editorUrl;
      return frame;
    },
    destroy() { host.remove(); }
  };
}
