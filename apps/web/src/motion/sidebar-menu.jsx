'use client';

import {useEffect, useId, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import {createPortal} from 'react-dom';
import {AnimatePresence, motion, useIsPresent} from 'motion/react';
import {surfaceTransition} from '../../public/ui-motion-policy.js';
import {useReducedMotionPreference} from './hooks.js';

const composing = event => event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229;

function MenuContents({children, id, label, menuRef, portal, position, triggerId}) {
  const reduced = useReducedMotionPreference();
  const present = useIsPresent();
  const surface=<motion.div ref={menuRef}
    id={id} role="region" aria-label={label} inert={!present}
    className={'sidebar-library-links'+(portal?' sidebar-menu-popover':'')} data-motion-surface="menu" data-menu-trigger-id={triggerId} style={position}
    initial={{opacity: 0, y: reduced ? 0 : -4}}
    animate={{opacity: 1, y: 0}}
    exit={{opacity: 0, y: reduced ? 0 : -4}}
    transition={surfaceTransition('menu', reduced)}
  >{children}</motion.div>;
  return portal?createPortal(surface,document.body):surface;
}

export function SidebarMenu({label, icon, children, className = '', compact=false, portal=false, disabled=false}) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const [position,setPosition]=useState(undefined);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const outside = event => {
      if (!root.current?.contains(event.target)&&!menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {document.removeEventListener('pointerdown', outside);document.removeEventListener('focusin',outside);};
  }, [open]);
  useEffect(()=>{if(!open||!portal)return;const close=event=>{if(!menu.current?.contains(event.target))setOpen(false);};window.addEventListener('resize',close);document.addEventListener('scroll',close,true);return()=>{window.removeEventListener('resize',close);document.removeEventListener('scroll',close,true);};},[open,portal]);

  function items() { return [...(menu.current?.querySelectorAll('a[href],button:not(:disabled)') ?? [])]; }
  function show(){if(portal){const rect=trigger.current.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(window.innerWidth-244,rect.right+6)),top:Math.max(8,Math.min(window.innerHeight-280,rect.top))});}setOpen(true);}

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
    flushSync(show);
    const links = items();
    (event.key === 'ArrowUp' ? links.at(-1) : links[0])?.focus({preventScroll: true});
  }

  return <div ref={root} className={'sidebar-library motion-sidebar-menu ' + className} onKeyDown={handleKeys}>
    <button
      ref={trigger} id={id+'-trigger'} type="button" className="sidebar-menu-trigger" disabled={disabled} aria-label={label}
      aria-expanded={open} aria-controls={id}
      onClick={() => {if(open)setOpen(false);else show();}} onKeyDown={openWithKey}
    >{icon}<span className={compact?'sr-only':undefined}>{label}</span></button>
    <AnimatePresence>
      {open && <MenuContents key="menu" id={id} label={label} menuRef={menu} portal={portal} position={position} triggerId={id+'-trigger'}>
        <div onClick={event => {
          if (event.target.closest('a[href],button:not(:disabled)')) {setOpen(false);if(menu.current?.contains(document.activeElement))trigger.current?.focus({preventScroll:true});}
        }}>{children}</div>
      </MenuContents>}
    </AnimatePresence>
  </div>;
}
