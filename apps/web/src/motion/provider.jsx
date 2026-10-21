'use client';

import {useCallback, useEffect, useLayoutEffect, useRef} from 'react';
import {MotionConfig} from 'motion/react';
import {MOTION_SURFACE_EVENT} from '../../public/motion-bridge.js';
import {blockPlacementChanges, surfaceTransition} from '../../public/ui-motion-policy.js';
import {useReducedMotionPreference, useSurfaceAnimate} from './hooks.js';
import {createRecordPanelDom} from '../../public/record-panel-dom.js';
import {createAnimatedRecordSurface} from '../../public/animated-record-surface.js';

/** Owns animated chrome. Document data, permissions and saving belong to the controllers. */
export function MotionUI({children}) {
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
    if (reduced) {clearPlacements();entry.current?.reduce();}
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
      const surface=createRecordPanelDom(document,model);
      let value;
      try{value=createAnimatedRecordSurface({surface,animate,getReducedMotion:()=>reducedRef.current,onDestroy:()=>{if(entry.current===value)entry.current=null;}});}
      catch{surface.destroy();return null;}
      entry.current=value;return value;
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
      entry.current?.destroy();
      entry.current = null;
    };
  }, [animate, clearPlacements]);

  return <MotionConfig reducedMotion="user" transition={surfaceTransition('menu', reduced)}>
    {children}
  </MotionConfig>;
}
