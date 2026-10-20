'use client';

import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal, flushSync} from 'react-dom';
import {AnimatePresence, MotionConfig} from 'motion/react';
import {MOTION_SURFACE_EVENT} from '../../public/motion-bridge.js';
import {blockPlacementChanges, surfaceTransition} from '../../public/ui-motion-policy.js';
import {useReducedMotionPreference, useSurfaceAnimate} from './hooks.js';
import {RecordSurface} from './record-surface.jsx';

/** Owns animated chrome. Document data, permissions and saving belong to the controllers. */
export function MotionUI({children}) {
  const [panel, setPanel] = useState(null);
  const [reset, setReset] = useState(0);
  const surface = useRef(null);
  const entry = useRef(null);
  const placements = useRef(new Map());
  const reduced = useReducedMotionPreference();
  const reducedRef = useRef(reduced);
  const animate = useSurfaceAnimate();
  reducedRef.current = reduced;

  const clearPlacements = useCallback(() => {
    for (const [element, control] of placements.current) {
      control.stop();
      element.style.transform = '';
    }
    placements.current.clear();
  }, []);

  useEffect(() => {
    if (reduced) clearPlacements();
  }, [reduced, clearPlacements]);

  useLayoutEffect(() => {
    function placeBlocks({root, before}) {
      clearPlacements();
      if (reducedRef.current || root.classList.contains('block-dragging')) return;
      for (const {element, x, y} of blockPlacementChanges(root, before)) {
        const control = animate(element, {x: [x, 0], y: [y, 0]}, surfaceTransition('placement'));
        placements.current.set(element, control);
        control.then(() => {
          if (placements.current.get(element) !== control) return;
          placements.current.delete(element);
          element.style.transform = '';
        });
      }
    }

    function openRecord(model) {
      if (entry.current) return null;
      const value = {id: crypto.randomUUID(), resolve: null};
      entry.current = value;
      flushSync(() => setPanel({...model, id: value.id}));
      const refs = surface.current;
      return {
        get host() { return refs.host; },
        get frame() { return refs.frame; },
        get exit() { return refs.exit; },
        get full() { return refs.full; },
        get status() { return refs.status; },
        setStatus: refs.setStatus,
        retryFrame: refs.retryFrame,
        close: () => new Promise(resolve => {
          value.resolve = resolve;
          setPanel(null);
        }),
        destroy() {
          if (entry.current !== value) return;
          entry.current = null;
          value.resolve?.();
          // Permission loss and teardown must not wait for an exit animation.
          flushSync(() => {
            setPanel(null);
            setReset(key => key + 1);
          });
        }
      };
    }

    function handle(event) {
      const request = event.detail;
      if (!request || request.result) return;
      if (request.type === 'cancel-placement') {
        clearPlacements();
        request.result = true;
      } else if (request.type === 'placement') {
        placeBlocks(request.model);
        request.result = true;
      } else if (request.type === 'record') {
        request.result = openRecord(request.model);
      }
    }

    window.addEventListener(MOTION_SURFACE_EVENT, handle);
    return () => {
      window.removeEventListener(MOTION_SURFACE_EVENT, handle);
      clearPlacements();
      entry.current?.resolve?.();
      entry.current = null;
    };
  }, [animate, clearPlacements]);

  function completeExit() {
    entry.current?.resolve?.();
    if (entry.current) entry.current.resolve = null;
  }

  return <MotionConfig reducedMotion="user" transition={surfaceTransition('menu', reduced)}>
    {children}
    {typeof document !== 'undefined' && createPortal(
      <AnimatePresence key={reset} onExitComplete={completeExit}>
        {panel && <RecordSurface key={panel.id} ref={surface} model={panel}/>}
      </AnimatePresence>, document.body
    )}
  </MotionConfig>;
}
