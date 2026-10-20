'use client';

import {useEffect, useId, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import {AnimatePresence, motion, useIsPresent} from 'motion/react';
import {surfaceTransition} from '../../public/ui-motion-policy.js';
import {useReducedMotionPreference} from './hooks.js';

const ITEM_SELECTOR = '.sidebar-library-links a[href],.sidebar-library-links button:not(:disabled)';
const composing = event => event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229;

function MenuContents({children, id, label}) {
  const reduced = useReducedMotionPreference();
  const present = useIsPresent();
  return <motion.div
    id={id} role="region" aria-label={label} inert={!present}
    className="sidebar-library-links" data-motion-surface="menu"
    initial={{opacity: 0, y: reduced ? 0 : -4}}
    animate={{opacity: 1, y: 0}}
    exit={{opacity: 0, y: reduced ? 0 : -4}}
    transition={surfaceTransition('menu', reduced)}
  >{children}</motion.div>;
}

export function SidebarMenu({label, icon, children, className = ''}) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const outside = event => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function items() { return [...(root.current?.querySelectorAll(ITEM_SELECTOR) ?? [])]; }

  function handleKeys(event) {
    if (composing(event)) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({preventScroll: true});
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const links = items();
    const index = links.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links[next]?.focus();
  }

  function openWithKey(event) {
    if (composing(event) || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    // Mount before focusing, including when the browser throttles animation frames.
    flushSync(() => setOpen(true));
    const links = items();
    (event.key === 'ArrowUp' ? links.at(-1) : links[0])?.focus({preventScroll: true});
  }

  return <div ref={root} className={'sidebar-library motion-sidebar-menu ' + className} onKeyDown={handleKeys}>
    <button
      ref={trigger} type="button" className="sidebar-menu-trigger"
      aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)} onKeyDown={openWithKey}
    >{icon}{label}</button>
    <AnimatePresence>
      {open && <MenuContents key="menu" id={id} label={label}>
        <div onClick={event => {
          if (event.target.closest('a[href],button:not(:disabled)')) setOpen(false);
        }}>{children}</div>
      </MenuContents>}
    </AnimatePresence>
  </div>;
}
