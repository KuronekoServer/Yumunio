import {mountRecordPanelSize} from './record-panel-size.js';

/** Insert a browsing context with its destination already set, avoiding an initial blank navigation. */
export function mountRecordEditorFrame(document,host,model){
  const frame=document.createElement('iframe');
  frame.className='record-detail-frame';frame.title=model.editorTitle;frame.loading='eager';frame.referrerPolicy='same-origin';
  frame.src=model.editorUrl;
  host.append(frame);
  return frame;
}

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

  header.append(exit, status, full);
  host.append(header);
  document.body.append(host);
  const size=mountRecordPanelSize({document,host,model});
  let frame = mountRecordEditorFrame(document,host,model);

  return {
    host, exit, full, status,
    get frame() { return frame; },
    setStatus(text, title = '') {
      status.textContent = text;
      status.title = title;
    },
    retryFrame() {
      frame.remove();
      frame = mountRecordEditorFrame(document,host,model);
      return frame;
    },
    destroy() { size.destroy();host.remove(); }
  };
}
