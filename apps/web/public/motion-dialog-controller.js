import {surfaceTransition} from './ui-motion-policy.js';

/** Animate a native dialog without taking ownership of its widget children. */
export function bindMotionDialog({dialog, animate, isReducedMotion, isComposing, onShade}) {
  const document = dialog.ownerDocument;
  const originalShow = dialog.showModal;
  const originalClose = dialog.close;
  const originalImmediate = dialog.closeImmediately;
  const nativeShow = () => originalShow.call(dialog);
  const nativeClose = value => originalClose.call(dialog, value);
  let controls = null;
  let closing = false;
  let sequence = 0;
  let priorFocus = null;
  let menuTrigger = null;
  let disposed = false;

  function stop() {
    sequence++;
    controls?.stop();
    controls = null;
    dialog.style.opacity = '';
    dialog.style.transform = '';
    dialog.inert = false;
  }

  function cancel(event) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (!isComposing() && dialog.open) dialog.close();
  }

  function nativeClosed() {
    // A queued close event from a previous view must not hide the next view's shade.
    if (!dialog.open) onShade(null);
  }

  dialog.showModal = () => {
    if (closing && dialog.open) nativeClose();
    stop();
    closing = false;
    priorFocus = document.activeElement;
    // An exiting menu can remove its action before the dialog closes. Remember
    // the persistent opener so keyboard navigation can resume from the sidebar.
    menuTrigger = priorFocus?.closest?.('.motion-sidebar-menu')?.querySelector('.sidebar-menu-trigger') ?? null;
    if (!dialog.open) nativeShow();
    queueMicrotask(() => {
      if (disposed) return;
      // Let existing busy/unsaved guards cancel Escape before our close handler.
      dialog.removeEventListener('cancel', cancel);
      dialog.addEventListener('cancel', cancel);
    });
    const kind = dialog.dataset.motionKind === 'menu' ? 'menu' : 'modal';
    onShade({kind});
    controls = animate(dialog, {
      opacity: [0, 1], y: isReducedMotion() ? 0 : [6, 0]
    }, surfaceTransition(kind, isReducedMotion()));
  };

  dialog.close = value => {
    if (!dialog.open || closing) return;
    stop();
    closing = true;
    dialog.inert = true;
    onShade(null);
    const marker = sequence;
    const kind = dialog.dataset.motionKind === 'menu' ? 'menu' : 'modal';
    controls = animate(dialog, {
      opacity: 0, y: isReducedMotion() ? 0 : 4
    }, surfaceTransition(kind, isReducedMotion()));
    controls.then(() => {
      if (marker !== sequence) return;
      closing = false;
      dialog.inert = false;
      nativeClose(value);
      dialog.style.opacity = '';
      dialog.style.transform = '';
      const focus = document.activeElement;
      if (focus === document.body || dialog.contains(focus)) {
        const target = priorFocus?.isConnected && !priorFocus.closest?.('[inert]') ? priorFocus : menuTrigger;
        if (target?.isConnected) target.focus({preventScroll: true});
      }
    });
  };

  dialog.closeImmediately = value => {
    stop();
    closing = false;
    onShade(null);
    if (dialog.open) nativeClose(value);
  };
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', nativeClosed);

  return {
    finish() { controls?.complete(); },
    destroy() {
      disposed = true;
      stop();
      if (dialog.open) nativeClose();
      dialog.showModal = originalShow;
      dialog.close = originalClose;
      if (originalImmediate === undefined) delete dialog.closeImmediately;
      else dialog.closeImmediately = originalImmediate;
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('close', nativeClosed);
    }
  };
}
