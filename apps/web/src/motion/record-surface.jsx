'use client';

import {forwardRef, memo, useImperativeHandle, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import {motion, useIsPresent} from 'motion/react';
import {surfaceTransition} from '../../public/ui-motion-policy.js';
import {useReducedMotionPreference} from './hooks.js';

// Saving feedback must never replace the iframe or the editor DOM inside it.
const EditorFrame = memo(forwardRef(function EditorFrame({src, title}, ref) {
  return <iframe ref={ref} className="record-detail-frame" src={src} title={title} referrerPolicy="same-origin"/>;
}));

export const RecordSurface = forwardRef(function RecordSurface({model}, ref) {
  const host = useRef(null);
  const frame = useRef(null);
  const exit = useRef(null);
  const full = useRef(null);
  const status = useRef(null);
  const [feedback, setFeedback] = useState({text: model.loading, title: ''});
  const [attempt, setAttempt] = useState(0);
  const reduced = useReducedMotionPreference();
  const present = useIsPresent();

  useImperativeHandle(ref, () => ({
    get host() { return host.current; },
    get frame() { return frame.current; },
    get exit() { return exit.current; },
    get full() { return full.current; },
    get status() { return status.current; },
    setStatus(text, title = '') { setFeedback({text, title}); },
    retryFrame() {
      flushSync(() => setAttempt(value => value + 1));
      return frame.current;
    }
  }), []);

  return <motion.aside
    ref={host}
    className="record-detail-panel"
    aria-label={model.title}
    role="region"
    inert={!present}
    data-motion-surface="panel"
    initial={{x: reduced ? 0 : '100%'}}
    animate={{x: 0}}
    exit={{x: reduced ? 0 : '100%'}}
    transition={surfaceTransition('panel', reduced)}
  >
    <header className="record-detail-header">
      <button ref={exit} type="button" className="button quiet" onClick={model.onClose}>{model.closeLabel}</button>
      <span ref={status} className="record-detail-status" role="status" title={feedback.title}>{feedback.text}</span>
      <a ref={full} className="button quiet" href={model.fullUrl} onClick={model.onFullPage}>{model.fullPageLabel}</a>
    </header>
    <EditorFrame key={attempt} ref={frame} src={model.editorUrl} title={model.editorTitle}/>
  </motion.aside>;
});
