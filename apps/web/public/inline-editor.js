import {validatePageLinks,rebasePageLinks,replacePageLinks,setPageLink,removePageLinks} from './page-links.js';
import { validateInlineMarks, rebaseInlineMarks, replaceInlineMarks, splitInlineMarks, formatInlineRange, safeInlineHref } from './inline-text.js';
import { markdownPrefix } from './editor-model.js';
import {validateMentions,rebaseMentions,replaceMentions} from './mentions.js';
export const MAX_INLINE_TEXT = 100000;
const controllers = new WeakMap();
const selectionDocuments = new WeakSet();
export const inlineFormattingLabels = translate => Object.fromEntries(['toolbar','bold','italic','strike','underline','code','link','unlink','url','apply','cancel','invalidLink','singleBlockOnly','openLink','pageLink','removePageLink','pageTarget','openPageLink','loadingPages','noPages','referenceError'].map(name => [name, translate('inline.' + name)]));

/** Literal text and validated semantic wrappers only. Stored HTML is never rendered. */
export function renderInlineText(element, text, marks = [], links = [], {pageHref,mentions=[]} = {}) {
  const source=validateInlineMarks(text,marks),references=validatePageLinks(text,links,{allowUnavailable:true}),tagged=validateMentions(text,mentions,{allowUnavailable:true}),nodes=[];
  const points=[...new Set([0,text.length,...source.flatMap(mark=>[mark.start,mark.end]),...references.flatMap(link=>[link.start,link.end]),...tagged.flatMap(mention=>[mention.start,mention.end])])].sort((a,b)=>a-b);
  let markIndex=0,linkIndex=0,mentionIndex=0;
  for(let index=0;index<points.length-1;index++){
    const start=points[index],end=points[index+1];if(start===end)continue;
    while(source[markIndex]?.end<=start)markIndex++;while(references[linkIndex]?.end<=start)linkIndex++;while(tagged[mentionIndex]?.end<=start)mentionIndex++;
    const mark=source[markIndex]?.start<=start?source[markIndex]:null,reference=references[linkIndex]?.start<=start?references[linkIndex]:null,mention=tagged[mentionIndex]?.start<=start?tagged[mentionIndex]:null;
    let child=element.ownerDocument.createTextNode(text.slice(start,end));
    for(const style of mark?.styles??[]){const wrapper=element.ownerDocument.createElement(({bold:'strong',italic:'em',strike:'s',underline:'u',code:'code'})[style]);wrapper.append(child);child=wrapper;}
    if(mention){const href=mention.kind==='page'&&!mention.unavailable&&pageHref?.(mention),wrapper=element.ownerDocument.createElement(href?'a':mention.kind==='date'?'time':'span');wrapper.className='inline-mention inline-mention-'+mention.kind+(mention.unavailable?' is-unavailable':'');if(href){if(typeof href!=='string'||!href.startsWith('/workspace?'))throw new TypeError('INVALID_MENTIONS');wrapper.href=href;}if(mention.kind==='date'&&!mention.unavailable)wrapper.setAttribute('datetime',mention.date);wrapper.append(child);child=wrapper;}
    else if(reference){const href=!reference.unavailable&&!reference.attachmentId&&pageHref?.(reference);const wrapper=element.ownerDocument.createElement(href?'a':'span');wrapper.className='inline-page-reference'+(reference.unavailable?' is-unavailable':'');if(href){if(typeof href!=='string'||!href.startsWith('/workspace?'))throw new TypeError('INVALID_PAGE_LINKS');wrapper.href=href;}wrapper.append(child);child=wrapper;}
    else if(mark?.href){const link=element.ownerDocument.createElement('a');link.href=safeInlineHref(mark.href);link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';link.append(child);child=link;}
    nodes.push(child);
  }
  element.replaceChildren(...nodes);
}

function observeSelection(element) {
  const doc = element.ownerDocument;
  if (selectionDocuments.has(doc)) return;
  selectionDocuments.add(doc); let active = null;
  doc.addEventListener('selectionchange', () => {
    const selection = doc.getSelection(), anchor = selection?.anchorNode;
    const closest = endpoint => (endpoint?.nodeType === Node.ELEMENT_NODE ? endpoint : endpoint?.parentElement)?.closest('.inline-editor');
    let editor = closest(anchor) || closest(selection?.focusNode);
    if (!editor && selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      editor = [...doc.querySelectorAll('.inline-editor')].find(candidate => range.intersectsNode(candidate));
    }
    const next = editor ? controllers.get(editor) : null;
    if (active && active !== next && !active.toolbar?.contains(doc.activeElement)) active.hide();
    active = next || (active?.toolbar?.contains(doc.activeElement) ? active : null);
    active?.selectionChanged();
  });
}

/** Compact selection toolbar; link entry uses ordinary controls rather than HTML editing. */
export function createInlineToolbar(element, { labels = {}, pageReferences } = {}) {
  const controller = controllers.get(element);
  if (!controller?.formatEnabled) return null;
  const doc = element.ownerDocument, toolbar = doc.createElement('div');
  const label = name => labels[name] || ({ toolbar: 'Text formatting', bold: 'Bold', italic: 'Italic', strike: 'Strikethrough', underline: 'Underline', code: 'Inline code', link: 'Web link', unlink: 'Remove link', url: 'Web address (http or https)', apply: 'Apply', cancel: 'Cancel', invalidLink: 'Enter a valid http or https address.', singleBlockOnly: 'Select text within one block to format it.', openLink: 'Open web link in a new tab', pageLink:'Link to a page',removePageLink:'Remove page reference',pageTarget:'Visible page',openPageLink:'Open referenced page',loadingPages:'Loading visible pages',noPages:'No visible pages',referenceError:'The page reference could not be changed.' })[name];
  toolbar.className = 'inline-format-toolbar'; toolbar.hidden = true;
  toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', label('toolbar'));
  const commands = doc.createElement('div'); commands.className = 'inline-format-commands'; toolbar.append(commands);
  const hint = doc.createElement('span'); hint.className = 'inline-format-hint'; hint.hidden = true; hint.textContent = label('singleBlockOnly'); toolbar.append(hint);
  const buttons = new Map();
  function control(name, glyph, handler) {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = glyph;
    button.title = label(name); button.setAttribute('aria-label', label(name));
    button.className = 'inline-format-button format-' + name;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', handler); commands.append(button); buttons.set(name, button); return button;
  }
  for (const [name, glyph] of [['bold', 'B'], ['italic', 'I'], ['strike', 'S'], ['underline', 'U'], ['code', '</>']]) control(name, glyph, () => controller.format({ style: name }));
  const form = doc.createElement('form'); form.className = 'inline-link-form'; form.hidden = true;
  const fieldLabel = doc.createElement('label'); fieldLabel.textContent = label('url');
  const input = doc.createElement('input'); input.type = 'url'; input.maxLength = 2048; input.placeholder = 'https://'; input.autocomplete = 'off'; input.spellcheck = false; fieldLabel.append(input);
  const apply = doc.createElement('button'); apply.type = 'submit'; apply.textContent = label('apply');
  const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = label('cancel');
  const error = doc.createElement('span'); error.className = 'inline-link-error'; error.setAttribute('role', 'alert');
  form.append(fieldLabel, apply, cancel, error); toolbar.append(form);
  const close = () => { form.hidden = true; error.textContent = ''; controller.restoreSelection(); };
  controller.openLink = () => {
    if (!controller.savedSelection || controller.composing) return;
    toolbar.hidden = false; pageForm.hidden=true; form.hidden = false; error.textContent = '';
    const selection = controller.savedSelection;
    input.value = controller.marks.find(mark => mark.start <= selection.start && mark.end >= selection.end)?.href || '';
    input.focus(); input.select();
  };
  control('link', '↗', controller.openLink); control('unlink', '×↗', () => controller.format({ href: null }));
  const open = doc.createElement('a'); open.textContent = label('openLink'); open.target = '_blank'; open.rel = 'noopener noreferrer'; open.referrerPolicy = 'no-referrer'; open.className = 'inline-format-open'; open.hidden = true; open.addEventListener('click',event=>event.stopPropagation()); toolbar.append(open);
  form.addEventListener('submit', event => {
    event.preventDefault();
    try { const href = safeInlineHref(input.value); form.hidden = true; error.textContent = ''; controller.format({ href }); }
    catch { error.textContent = label('invalidLink'); input.focus(); }
  });
  cancel.addEventListener('click', close);
  form.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='k') { event.preventDefault(); event.stopPropagation(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
  const pageForm=doc.createElement('form');pageForm.className='inline-link-form';pageForm.hidden=true;
  const pageLabel=doc.createElement('label');pageLabel.textContent=label('pageTarget');const pageSelect=doc.createElement('select');pageLabel.append(pageSelect);
  const pageApply=doc.createElement('button');pageApply.type='submit';pageApply.textContent=label('apply');const pageCancel=doc.createElement('button');pageCancel.type='button';pageCancel.textContent=label('cancel');const pageStatus=doc.createElement('span');pageStatus.setAttribute('role','status');pageForm.append(pageLabel,pageApply,pageCancel,pageStatus);
  const pageOpen=doc.createElement('a');pageOpen.className='inline-format-open';pageOpen.textContent=label('openPageLink');pageOpen.hidden=true;
  if(pageReferences){toolbar.append(pageForm,pageOpen);control('pageLink','@',async()=>{
    if(!controller.savedSelection||controller.composing)return;form.hidden=true;pageForm.hidden=false;pageStatus.textContent=label('loadingPages');pageSelect.replaceChildren();pageApply.disabled=true;
    try{const candidates=await pageReferences.load();if(!element.isConnected||pageForm.hidden)return;const used=new Set();for(const candidate of candidates){if(typeof candidate?.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.id)||typeof candidate.title!=='string'||used.has(candidate.id))throw Error();used.add(candidate.id);const option=doc.createElement('option');option.value=candidate.id;option.textContent=candidate.title;pageSelect.append(option);}pageStatus.textContent=candidates.length?'':label('noPages');pageApply.disabled=!candidates.length;pageSelect.focus();}catch{pageStatus.textContent=label('referenceError');}
  });control('removePageLink','x@',()=>controller.reference(null));
  pageForm.addEventListener('submit',event=>{event.preventDefault();if(pageApply.disabled||!pageSelect.value)return;pageForm.hidden=true;controller.reference(pageSelect.value);});pageCancel.addEventListener('click',()=>{pageForm.hidden=true;controller.restoreSelection();});pageForm.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();pageForm.hidden=true;controller.restoreSelection();}});}
  controller.toolbar = toolbar;
  controller.selectionChanged = () => {
    if (toolbar.contains(doc.activeElement)) return;
    const selection = captureInlineSelection(element);
    const current = doc.getSelection(), crossesBlock = !selection && current?.rangeCount && !current.isCollapsed && current.getRangeAt(0).intersectsNode(element);
    for (const button of buttons.values()) button.disabled = !!crossesBlock;
    hint.hidden = !crossesBlock;
    if (crossesBlock) { toolbar.hidden = false; form.hidden = true; pageForm.hidden=true;pageOpen.hidden=true; open.hidden = true; controller.savedSelection = null; return; }
    if (!selection || selection.start === selection.end || controller.composing) { toolbar.hidden = true; form.hidden = true;pageForm.hidden=true;pageOpen.hidden=true; return; }
    controller.savedSelection = selection; toolbar.hidden = false;
    const href = controller.marks.find(mark => mark.start <= selection.start && mark.end >= selection.end)?.href;
    open.hidden = !href; if (href) open.href = safeInlineHref(href); else open.removeAttribute('href');
    const reference=controller.links.find(link=>link.start<=selection.start&&link.end>=selection.end&&!link.unavailable&&!link.attachmentId),referenceHref=reference&&pageReferences?.href(reference);
    pageOpen.hidden=!referenceHref;if(referenceHref)pageOpen.href=referenceHref;else pageOpen.removeAttribute('href');
    for (const [name, button] of buttons) {
      if (['link', 'unlink','pageLink','removePageLink'].includes(name)) continue;
      let covered = selection.start;
      for (const mark of controller.marks) {
        if (mark.end <= covered) continue;
        if (mark.start > covered || !mark.styles.includes(name)) break;
        covered = Math.min(selection.end, mark.end); if (covered === selection.end) break;
      }
      button.setAttribute('aria-pressed', String(covered === selection.end));
    }
  };
  controller.hide = () => { toolbar.hidden = true; form.hidden = true;pageForm.hidden=true; };
  observeSelection(element); return toolbar;
}

export function normalizePlainText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
}
export function replaceTextRange(text, start, end, inserted) {
  const source = normalizePlainText(text);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) throw new RangeError('INVALID_TEXT_RANGE');
  const value = normalizePlainText(inserted);
  const next = source.slice(0, start) + value + source.slice(end);
  if (next.length > MAX_INLINE_TEXT) throw new RangeError('TEXT_TOO_LONG');
  return { text: next, caret: start + value.length };
}
export function splitTextRange(text, start, end) {
  const source = normalizePlainText(text);
  replaceTextRange(source, start, end, '');
  return { before: source.slice(0, start), after: source.slice(end) };
}
export function isComposingInput(event) { return event.isComposing === true || event.keyCode === 229; }

export function readInlineText(element) {
  if ([...element.childNodes].every(node => node.nodeType === Node.TEXT_NODE)) return normalizePlainText(element.textContent);
  const walk = parent => [...parent.childNodes].map((node, index) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.nodeName === 'BR') return '\n';
    const value = walk(node);
    return ['DIV', 'P', 'LI'].includes(node.nodeName) && index > 0 ? '\n' + value : value;
  }).join('');
  const text = walk(element);
  return element.textContent === '' && text === '\n' ? '' : normalizePlainText(text);
}
export function captureInlineSelection(element) {
  const selection = element.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const prefix = range.cloneRange(); prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return { start, end: prefix.toString().length };
}
export function focusInlineEditor(element, { start = 0, end = start, scroll = true } = {}) {
  if (!element) return;
  element.focus({ preventScroll: true });
  const length = element.textContent.length;
  const locate = offset => {
    let remaining = Math.max(0, Math.min(offset, length));
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.textContent.length) return [node, remaining];
      remaining -= node.textContent.length;
    }
    return [element, element.childNodes.length];
  };
  const [startNode, startOffset] = locate(start);
  const [endNode, endOffset] = locate(end);
  const range = element.ownerDocument.createRange();
  range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
  const selection = element.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  if (scroll) element.scrollIntoView({ block: 'nearest' });
}

function selectionOffsets(element,{start=0,end=start,direction='forward'}={}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start<0 || end<start || end>element.textContent.length || !['forward','backward'].includes(direction)) throw new RangeError('INVALID_TEXT_RANGE');
  return {start,end,direction};
}
/** UTF-16 offsets; a background update never focuses another editor. */
export function setInlineSelection(element,options={}) {
  if (!element || controllers.get(element)?.composing) return false;
  const {start,end,direction}=selectionOffsets(element,options),doc=element.ownerDocument;
  if (!options.focus && doc.activeElement!==element) return false;
  const selection=doc.getSelection();if(!selection)return false;
  const locate=offset=>{let remaining=offset;const walker=doc.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){if(remaining<=node.textContent.length)return[node,remaining];remaining-=node.textContent.length;}return[element,element.childNodes.length];};
  const [startNode,startOffset]=locate(start),[endNode,endOffset]=locate(end);
  if(options.focus)element.focus({preventScroll:true});
  if(typeof selection.setBaseAndExtent==='function') {
    if(direction==='backward')selection.setBaseAndExtent(endNode,endOffset,startNode,startOffset);
    else selection.setBaseAndExtent(startNode,startOffset,endNode,endOffset);
  } else {
    const range=doc.createRange();range.setStart(startNode,startOffset);range.setEnd(endNode,endOffset);selection.removeAllRanges();selection.addRange(range);
    if(direction==='backward'&&typeof selection.extend==='function'){selection.collapse(endNode,endOffset);selection.extend(startNode,startOffset);}
  }
  if(options.scroll)element.scrollIntoView({block:'nearest'});return true;
}
export function getInlineEditorState(element) { return controllers.get(element)?.snapshot() ?? null; }
export function insertInlineMention(element,options={}) { return controllers.get(element)?.insertMention(options) ?? false; }
export function preflightInlineEditorPatch(element,snapshot,options={}) { return controllers.get(element)?.preflight(snapshot,options) ?? {ready:false,reason:'unavailable'}; }
export function patchInlineEditor(element,snapshot,options={}) { return controllers.get(element)?.patch(snapshot,options) ?? {applied:false,reason:'unavailable'}; }
function plainPatchOperations(element,before,after) {
  const nodes=[...element.childNodes];if(nodes.some(node=>node.nodeType!==Node.TEXT_NODE))return null;
  let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  let suffix=0;while(suffix<before.length-start&&suffix<after.length-start&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const end=before.length-suffix,inserted=after.slice(start,after.length-suffix),operations=[];let offset=0,insertedAt=false;
  for(const node of nodes){const length=node.textContent.length,localStart=Math.max(0,Math.min(length,start-offset)),localEnd=Math.max(0,Math.min(length,end-offset));let insertion='';if(!insertedAt&&start>=offset&&start<=offset+length){insertion=inserted;insertedAt=true;}if(localEnd>localStart||insertion)operations.push({node,start:localStart,deleteCount:localEnd-localStart,inserted:insertion});offset+=length;}
  return {operations,append:!nodes.length?inserted:null};
}

export function createInlineEditor({ text = '', marks = [], links = [], mentions = [], pageHref, label, placeholder = '', readOnly = false, maxTextLength = MAX_INLINE_TEXT, formatEnabled = true, preserveInsertedFormatting = true, className = '',
  onChange = () => {}, onBeforeFormat = () => {}, onFormatError = () => onLimit(), onClipboard, onSplit, onMerge, onSlash, onNavigate, onShortcut, onHistory, onIndent, onStructureError = () => {}, onLimit = () => {} } = {}) {
  if(!Number.isSafeInteger(maxTextLength)||maxTextLength<1||maxTextLength>maxTextLength)throw new RangeError('INVALID_TEXT_LIMIT');
  const element = document.createElement('div');
  element.className = 'inline-editor ' + className;
  element.setAttribute('role', 'textbox');
  element.setAttribute('aria-multiline', 'true');
  element.setAttribute('aria-label', label || '');
  element.setAttribute('aria-readonly', String(readOnly));
  element.setAttribute('translate', 'no');
  element.setAttribute('data-placeholder', readOnly ? '' : placeholder);
  element.setAttribute('aria-placeholder', readOnly ? '' : placeholder);
  element.setAttribute('contenteditable', readOnly ? 'false' : 'plaintext-only');
  element.spellcheck = true;
  let lastText = normalizePlainText(text), lastMarks = rebaseInlineMarks(String(text ?? ''), lastText, marks), composing = false, pendingEdit = null, tabNavigation = false;
  let lastLinks=rebasePageLinks(String(text??''),lastText,links),lastMentions=rebaseMentions(String(text??''),lastText,mentions);const paint=()=>renderInlineText(element,lastText,lastMarks,lastLinks,{pageHref,mentions:lastMentions});
  paint();
  // Internal page references can be handled by the workspace. Modified clicks keep normal browser navigation.
  if (!readOnly) element.addEventListener('click', event => { if (event.target.closest?.('a')&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey) event.preventDefault(); });
  const controller = {
    formatEnabled: !readOnly && formatEnabled, get mentions(){return lastMentions;}, get links(){return lastLinks;}, get marks() { return lastMarks; }, get composing() { return composing; }, savedSelection: null,
    selectionChanged() {}, hide() {}, restoreSelection() { if (this.savedSelection) focusInlineEditor(element, { ...this.savedSelection, scroll: false }); },
    insertMention({start,end,text:inserted,target,expectedText}={}) {
      if(readOnly||!formatEnabled||composing||typeof inserted!=='string'||inserted.length===0||inserted.length>260||expectedText!==lastText||readInlineText(element)!==lastText)return false;
      try {
        const next=replaceTextRange(lastText,start,end,inserted),nextMentions=replaceMentions(lastText,lastMentions,start,end,inserted);
        nextMentions.push({...target,start,end:start+inserted.length});nextMentions.sort((a,b)=>a.start-b.start);
        const valid=validateMentions(next.text,nextMentions,{allowUnavailable:true}),metadata={marks:replaceInlineMarks(lastText,lastMarks,start,end,inserted,{inherit:false}),links:replacePageLinks(lastText,lastLinks,start,end,inserted),mentions:valid};
        onBeforeFormat();pendingEdit=null;changed(next.text,metadata,{start:next.caret},'mention');return true;
      }catch{onFormatError();return false;}
    },
    reference(pageId){
      if(!formatEnabled||composing)return;const selection=captureInlineSelection(element)||this.savedSelection;if(!selection||selection.start===selection.end)return;commit();
      try{const next=pageId===null?removePageLinks(lastText,lastLinks,selection.start,selection.end):setPageLink(lastText,lastLinks,selection.start,selection.end,pageId);if(JSON.stringify(next)===JSON.stringify(lastLinks)){this.restoreSelection();return;}this.savedSelection=selection;this.restoreSelection();onBeforeFormat();lastLinks=next;if(pageId!==null)lastMarks=formatInlineRange(lastText,lastMarks,selection.start,selection.end,{href:null});paint();this.restoreSelection();onChange(lastText,{marks:lastMarks,links:lastLinks,mentions:lastMentions,kind:'reference'});this.selectionChanged();}catch{onFormatError();}
    },
    format(command) {
      if (!formatEnabled || composing) return;
      const selection = captureInlineSelection(element) || this.savedSelection;
      if (!selection || selection.start === selection.end) return;
      commit();
      try {
        const next = formatInlineRange(lastText, lastMarks, selection.start, selection.end, command);
        if (JSON.stringify(next) === JSON.stringify(lastMarks)) { this.restoreSelection(); return; }
        this.savedSelection = selection; this.restoreSelection(); onBeforeFormat(); lastMarks = next;
        if(Object.hasOwn(command,'href')&&command.href!==null)lastLinks=removePageLinks(lastText,lastLinks,selection.start,selection.end);
        paint(); this.restoreSelection();
        onChange(lastText, { marks: lastMarks, links:lastLinks, mentions:lastMentions, kind: 'format',range:{start:selection.start,end:selection.end} }); this.selectionChanged();
      } catch { onFormatError(); }
    }
  };
  function prepareRemote(snapshot,options={}) {
    if(composing)return {ready:false,reason:'composing'};
    if(pendingEdit)return {ready:false,reason:'pending-input'};
    if(controller.toolbar?.contains(element.ownerDocument.activeElement))return {ready:false,reason:'format-input'};
    if(Object.hasOwn(options,'expectedText')&&options.expectedText!==lastText)return {ready:false,reason:'baseline-mismatch'};
    if(readInlineText(element)!==lastText||element.textContent!==lastText)return {ready:false,reason:'pending-input'};
    try {
      if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)||![Object.prototype,null].includes(Object.getPrototypeOf(snapshot)))throw new TypeError();
      const descriptors=Object.getOwnPropertyDescriptors(snapshot);if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!['text','marks','links','mentions'].includes(key)||!Object.hasOwn(descriptors[key],'value'))||!Object.hasOwn(descriptors,'text'))throw new TypeError();
      const value=snapshot.text;if(typeof value!=='string'||value.length>maxTextLength||normalizePlainText(value)!==value)throw new TypeError();
      const nextMarks=snapshot.marks!==undefined?validateInlineMarks(value,snapshot.marks):rebaseInlineMarks(lastText,value,lastMarks);
      const nextLinks=snapshot.links!==undefined?validatePageLinks(value,snapshot.links,{allowUnavailable:true}):rebasePageLinks(lastText,value,lastLinks);
      const nextMentions=snapshot.mentions!==undefined?validateMentions(value,snapshot.mentions,{allowUnavailable:true}):rebaseMentions(lastText,value,lastMentions);
      if(options.selection) { const {start=0,end=start,direction='forward'}=options.selection;if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>value.length||!['forward','backward'].includes(direction))throw new RangeError(); }
      const plain=!lastMarks.length&&!lastLinks.length&&!lastMentions.length&&!nextMarks.length&&!nextLinks.length&&!nextMentions.length?plainPatchOperations(element,lastText,value):null;
      let staged=null;if(!plain){staged=element.ownerDocument.createElement('div');renderInlineText(staged,value,nextMarks,nextLinks,{pageHref,mentions:nextMentions});}
      return {ready:true,text:value,marks:nextMarks,links:nextLinks,mentions:nextMentions,plain,staged};
    } catch { return {ready:false,reason:'invalid-snapshot'}; }
  }
  controller.snapshot=()=>({text:lastText,marks:structuredClone(lastMarks),links:structuredClone(lastLinks),mentions:structuredClone(lastMentions),composing,pendingEdit:pendingEdit!==null,readOnly});
  controller.preflight=(snapshot,options={})=>{const result=prepareRemote(snapshot,options);return result.ready?{ready:true,mode:result.plain?'text-splice':'runs'}:{ready:false,reason:result.reason};};
  controller.patch=(snapshot,options={})=>{
    const prepared=prepareRemote(snapshot,options);if(!prepared.ready)return {applied:false,ready:false,reason:prepared.reason};
    const mode=prepared.plain?'text-splice':'runs';if(options.dryRun)return {applied:false,ready:true,mode};
    if(prepared.plain){for(const operation of prepared.plain.operations)operation.node.replaceData(operation.start,operation.deleteCount,operation.inserted);if(prepared.plain.append!==null&&prepared.plain.append!=='')element.append(element.ownerDocument.createTextNode(prepared.plain.append));}
    else element.replaceChildren(...prepared.staged.childNodes);
    lastText=prepared.text;lastMarks=prepared.marks;lastLinks=prepared.links;lastMentions=prepared.mentions;pendingEdit=null;controller.savedSelection=null;controller.hide();
    const selectionApplied=options.selection?setInlineSelection(element,{...options.selection,focus:false,scroll:false}):false;
    return {applied:true,ready:true,mode,selectionApplied};
  };
  controllers.set(element, controller);
  Object.defineProperties(element,{
    patchInline:{value:(snapshot,options)=>patchInlineEditor(element,snapshot,options)},
    preflightInlinePatch:{value:(snapshot,options)=>preflightInlineEditorPatch(element,snapshot,options)},
    getInlineState:{value:()=>getInlineEditorState(element)},
    setInlineSelection:{value:options=>setInlineSelection(element,options)}
  });
  if(readOnly)return element;
  function changed(value, metadata, selection, kind='text') {
    if(value.length>maxTextLength)throw new RangeError('TEXT_TOO_LONG');
    lastText = value; lastMarks = metadata.marks;lastLinks=metadata.links;lastMentions=metadata.mentions;
    paint();
    if (selection) focusInlineEditor(element, { ...selection, scroll: false });
    onChange(value, { marks: lastMarks, links:lastLinks, mentions:lastMentions, kind }); controller.selectionChanged();
  }
  function editMetadata(value) {
    const edit = pendingEdit; pendingEdit = null;
    if (edit?.text === lastText) {
      let { start, end } = edit;
      if (start === end && value.length < lastText.length) {
        if (edit.inputType === 'deleteContentBackward') start -= lastText.length - value.length;
        else if (edit.inputType === 'deleteContentForward') end += lastText.length - value.length;
      }
      const insertedLength = value.length - (lastText.length - (end - start));
      if (start >= 0 && end <= lastText.length && insertedLength >= 0) {
        const inserted = value.slice(start, start + insertedLength);
        if (lastText.slice(0, start) + inserted + lastText.slice(end) === value) return {marks:replaceInlineMarks(lastText, lastMarks, start, end, inserted, { inherit: preserveInsertedFormatting }),links:replacePageLinks(lastText,lastLinks,start,end,inserted),mentions:replaceMentions(lastText,lastMentions,start,end,inserted)};
      }
    }
    return {marks:rebaseInlineMarks(lastText, value, lastMarks),links:rebasePageLinks(lastText,value,lastLinks),mentions:rebaseMentions(lastText,value,lastMentions)};
  }
  function commit() {
    if (composing) return;
    const value = readInlineText(element);
    const selection = captureInlineSelection(element);
    if (value.length > maxTextLength) {
      paint(); focusInlineEditor(element, selection || { start: lastText.length }); pendingEdit = null; onLimit(); return;
    }
    // Only our canonical runs survive browser DOM edits; pasted/browser HTML is never saved.
    try {
      if (value !== lastText) changed(value, editMetadata(value), selection);
      else { pendingEdit = null; paint(); if (selection) focusInlineEditor(element, { ...selection, scroll: false }); }
    } catch { pendingEdit = null; paint(); if (selection) focusInlineEditor(element, { ...selection, scroll: false }); onFormatError(); }
  }
  function insertText(value) {
    const selection = captureInlineSelection(element) || { start: lastText.length, end: lastText.length };
    try {
      commit();
      const next = replaceTextRange(lastText, selection.start, selection.end, value);
      const nextMarks = replaceInlineMarks(lastText, lastMarks, selection.start, selection.end, normalizePlainText(value), { inherit: preserveInsertedFormatting });
      if (next.text !== lastText) changed(next.text, {marks:nextMarks,links:replacePageLinks(lastText,lastLinks,selection.start,selection.end,normalizePlainText(value)),mentions:replaceMentions(lastText,lastMentions,selection.start,selection.end,normalizePlainText(value))}, { start: next.caret });
    } catch (error) { if (error?.message === 'TEXT_TOO_LONG') onLimit(); else onFormatError(); }
  }
  function split() {
    const selection = captureInlineSelection(element);
    if (!selection || !onSplit) return false;
    try { commit(); onSplit({ start: selection.start, end: selection.end, ...splitTextRange(lastText, selection.start, selection.end), ...splitInlineMarks(lastText, lastMarks, selection.start, selection.end) }); } catch { onFormatError(); } return true;
  }
  function completeLineShortcut(selection, value) {
    if (!onShortcut || selection?.start !== value.length || selection.end !== value.length) return false;
    const conversion = markdownPrefix(value + ' ');
    if (!conversion || !['code', 'divider'].includes(conversion.type) || onShortcut(value + ' ') !== true) return false;
    pendingEdit = null; return true;
  }
  element.addEventListener('compositionstart', () => { composing = true; controller.hide(); pendingEdit = { text: lastText, ...captureInlineSelection(element), inputType: 'insertCompositionText' }; });
  element.addEventListener('compositionend', () => { composing = false; commit(); });
  element.addEventListener('input', event => { if (!isComposingInput(event)) commit(); });
  element.addEventListener('keydown', event => {
    if (composing || isComposingInput(event)) return;
    const selection = captureInlineSelection(element);
    const value = readInlineText(element);
    if (event.key === 'Escape') { tabNavigation = true; controller.hide(); return; }
    if (event.key === 'Tab' && onIndent && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (tabNavigation) { tabNavigation = false; return; }
      if (!selection) { event.preventDefault(); onStructureError(); return; }
      if (onIndent(event.shiftKey ? 'outdent' : 'indent', selection) === true) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    tabNavigation = false;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (['b', 'i', 'u', 'k','e'].includes(event.key.toLowerCase())||event.shiftKey&&event.key.toLowerCase()==='s')) {
      if (event.key.toLowerCase()==='k' && (!selection || selection.start===selection.end)) return;
      event.preventDefault(); event.stopPropagation();
      if (formatEnabled && selection && selection.start !== selection.end) {
        controller.savedSelection = selection;
        if (event.key.toLowerCase() === 'k') controller.openLink?.();
        else controller.format({ style: ({ b: 'bold', i: 'italic', u: 'underline',e:'code',s:'strike' })[event.key.toLowerCase()] });
      }
      return;
    }
    if (event.key === '/' && value === '' && !event.ctrlKey && !event.metaKey && !event.altKey && onSlash) {
      event.preventDefault(); onSlash(); return;
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.shiftKey) { event.preventDefault(); insertText('\n'); }
      else { event.preventDefault(); if (!completeLineShortcut(selection, value)) { if (onSplit) split(); else insertText('\n'); } }
      return;
    }
    if (event.key === 'Backspace' && selection?.start === 0 && selection.end === 0 && onMerge) {
      if (onMerge(value) === true) event.preventDefault();
      return;
    }
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey && selection?.start === selection?.end && onNavigate) {
      if ((event.key === 'ArrowUp' && selection.start === 0) || (event.key === 'ArrowDown' && selection.end === value.length)) {
        if (onNavigate(event.key === 'ArrowUp' ? -1 : 1) === true) event.preventDefault();
      }
    }
  });
  element.addEventListener('beforeinput', event => {
    if (composing || isComposingInput(event)) return;
    const selection = captureInlineSelection(element);
    pendingEdit = selection ? { text: lastText, ...selection, inputType: event.inputType } : null;
    if (['historyUndo','historyRedo'].includes(event.inputType) && onHistory) { if(onHistory(event.inputType==='historyUndo'?'undo':'redo')===true){event.preventDefault();pendingEdit=null;} return; }
    if (event.inputType==='insertText' && event.data===' ' && onShortcut) {
      const selection=captureInlineSelection(element),value=readInlineText(element);
      if(selection?.start===value.length && selection.end===value.length && onShortcut(value+' ')===true) {event.preventDefault();pendingEdit=null;return;}
    }
    if (event.inputType?.startsWith('format')) { event.preventDefault(); pendingEdit=null; return; }
    if (event.inputType === 'insertParagraph') { event.preventDefault(); if (!completeLineShortcut(selection, readInlineText(element))) { if (onSplit) split(); else insertText('\n'); } }
    else if (event.inputType === 'insertLineBreak') { event.preventDefault(); insertText('\n'); }
    else if (event.inputType === 'insertText' && event.data === '/' && readInlineText(element) === '' && onSlash) { event.preventDefault(); pendingEdit=null; onSlash(); }
    else if (event.inputType === 'insertText' && typeof event.data === 'string') {
      const selection = captureInlineSelection(element);
      if (selection && readInlineText(element).length - (selection.end - selection.start) + event.data.length > maxTextLength) { event.preventDefault(); pendingEdit=null; onLimit(); }
    } else if (event.inputType === 'deleteContentBackward' && onMerge) {
      const selection = captureInlineSelection(element);
      if (selection?.start === 0 && selection.end === 0 && onMerge(readInlineText(element)) === true) { event.preventDefault(); pendingEdit=null; }
    }
  });
  element.addEventListener('paste', event => {
    event.preventDefault();
    if(composing||event.isComposing)return;
    if(onClipboard?.(event.clipboardData,captureInlineSelection(element),{kind:'paste'})===true)return;
    const text = event.clipboardData?.getData('text/plain');
    if (text) insertText(text);
  });
  element.addEventListener('drop', event => {
    event.preventDefault();
    if(composing||event.isComposing)return;
    if(onClipboard?.(event.dataTransfer,captureInlineSelection(element),{kind:'drop'})===true)return;
    const text = event.dataTransfer?.getData('text/plain');
    if (text) insertText(text);
  });
  element.addEventListener('dragover',event=>{if(onClipboard&&Array.from(event.dataTransfer?.types??[]).includes('Files'))event.preventDefault();});
  return element;
}
