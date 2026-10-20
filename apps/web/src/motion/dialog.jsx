'use client';

import {forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {AnimatePresence, motion} from 'motion/react';
import {bindMotionDialog} from '../../public/motion-dialog-controller.js';
import {surfaceTransition} from '../../public/ui-motion-policy.js';
import {useReducedMotionPreference, useSurfaceAnimate} from './hooks.js';

/** Native top-layer semantics remain intact; the editor owns the dialog children. */
export const MotionDialog = forwardRef(function MotionDialog({children, ...props}, forwarded) {
  const node = useRef(null);
  const composing = useRef(false);
  const controller = useRef(null);
  const reduced = useReducedMotionPreference();
  const reducedRef = useRef(reduced);
  const animate = useSurfaceAnimate();
  const [shade, setShade] = useState(null);
  reducedRef.current = reduced;

  useImperativeHandle(forwarded, () => node.current, []);
  useEffect(() => {
    if (reduced) controller.current?.finish();
  }, [reduced]);
  useLayoutEffect(() => {
    const binding = bindMotionDialog({
      dialog: node.current,
      animate,
      isReducedMotion: () => reducedRef.current,
      isComposing: () => composing.current,
      onShade: setShade
    });
    controller.current = binding;
    return () => {
      controller.current = null;
      binding.destroy();
    };
  }, [animate]);

  return <>
    <dialog
      ref={node} {...props} data-motion-dialog=""
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
    >{children}</dialog>
    {typeof document !== 'undefined' && createPortal(
      <AnimatePresence>
        {shade && <motion.div
          key="shade" className="motion-dialog-shade" aria-hidden="true"
          initial={{opacity: 0}} animate={{opacity: 1}} exit={{opacity: 0}}
          transition={surfaceTransition(shade.kind, reduced)}
        />}
      </AnimatePresence>, document.body
    )}
  </>;
});
