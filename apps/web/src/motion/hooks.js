'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {useAnimate, useReducedMotion} from 'motion/react';
import {observeReducedMotion} from '../../public/ui-motion-policy.js';

// Motion may replace animate when its configuration changes. Surface lifetimes
// must remain stable so that a preference change cannot destroy an open editor.
export function useSurfaceAnimate() {
  const [, animate] = useAnimate();
  const latest = useRef(animate);
  latest.current = animate;
  return useCallback((...args) => latest.current(...args), []);
}

export function useReducedMotionPreference() {
  const initial = useReducedMotion();
  const [reduced, setReduced] = useState(initial);
  // The installed Motion hook reads the initial preference; observe later changes.
  useEffect(() => observeReducedMotion(window, setReduced), []);
  return reduced;
}
