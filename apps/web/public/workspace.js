import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {createColumnResizeReview} from './column-resize-review.js';
import {loadInstanceConfig,applyInstanceDefaults,createInstanceBrand} from './instance.js';
import { importSourceText } from './shared/import-source.js';
import { EditorHistory, EDITABLE_BLOCK_TYPES, markdownPrefix } from './editor-model.js';
import { CollectionEdits, validateInlineBlockMetadata, editableBlockData, readableLinks, pageMoveTargets, mergeSavedPageAttachments, mapRoomSelection } from './workspace-data.js';
import { createInlineEditor, createInlineToolbar, inlineFormattingLabels, captureInlineSelection, focusInlineEditor, patchInlineEditor, preflightInlineEditorPatch, setInlineSelection, MAX_INLINE_TEXT } from './inline-editor.js';
import { indexEditorBlocks, canEditNestedBlock, canEditEditorParent, insertEditorColumns, wrapEditorBlockInColumns, unwrapEditorColumns, planEditorNesting, createEditorNestingPlanner, createEditorMovePlanner, moveEditorBlockTo, normalizeEditorBlockSelection, editorBlockSelectionRange, createEditorMultiMovePlanner, planEditorBlocksMove, moveEditorBlocksTo, nestEditorBlock, insertEditorBlock, splitEditorBlock, mergeEditorBlock, removeEditorBlock, MAX_EDITOR_NESTING, EDITOR_PARENT_TYPES } from './editor-tree.js';
import {prepareRoomTreeOperation,prepareRoomCheckOperation,prepareRoomSplitOperation,prepareRoomMergeOperation,prepareRoomConvertOperation} from './room-operations.js';
import {prepareRoomCheckboxPatch,applyRoomCheckboxPatch} from './room-check-ui.js';
import { PreferencesStore, THEMES, FONT_OPTIONS, validateCustomColors } from './preferences.js';
import { createI18n, loadCatalogs, createLocaleOptions, applyLocaleDocument, applyLocaleNotice } from './i18n.js';
import { createCollectionValueInput, renderRecordCollectionValue, collectionFieldHint } from './collection-fields.js';
import {mountWorkspaceCollectionView,validateWorkspaceCollectionRead} from './workspace-collection-view.js';
import { PageAutosave } from './page-autosave.js';
import { validateSavedPage, pageBlocksEqual } from './page-save-result.js';
import { createBlockDnd } from './block-dnd.js';
import {createMentionPicker} from './mention-picker.js';
import {createWorkspacePresence} from './workspace-presence.js';
import {planBlockForestMove} from './block-forest.js';
import {createPageBlockTransfer,validatePageBlockTransferResult} from './block-transfer.js';
import {mountSettingsDialog,settingsHrefSection} from './settings-dialog.js';
import {mountWorkspacePicker} from './workspace-picker.js';
import {sidebarPageRows,revealSidebarPage} from './sidebar-model.js';
import {TeamspaceClient} from './teamspace-client.js';
import {validateCreatedPage,validateCreatedPageProjection} from './page-create-result.js';
import {createSimpleTable,isSimpleTableData} from './simple-table.js';
import {createTableBlockView} from './table-block-view.js';

const app = document.getElementById('workspace-app');
const modal = document.getElementById('workspace-modal');
const workspaceId = new URL(location.href).searchParams.get('workspace') || '';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const clone = value => structuredClone(value);
const supportedTypes = [...EDITABLE_BLOCK_TYPES,'heading1','heading2'];
const blockChoices=['paragraph','heading1','heading2','heading3','checklist','bulleted-list','numbered-list','quote','divider','code'];
const state = { user: null, name: '', role: '', pages: [], listRevision: 0, current: null, draft: null,
  collection: null, collectionError: '', recordError: '', people: [],
  dirty: false, busy: false, loading: false, listLoading: false, conflict: false, locked: false,
  fatal: '', notice: '', error: '', navOpen: false, selection: 0, listGeneration: 0, teamspaces: [], teamsAvailable:false };
let workspaceBrand,instanceConfig;
let preferences = new PreferencesStore(), i18n, fieldI18n, pageController, saveButton, saveStatus, sidebar, mainPanel, navButton;
let draggedPageId=null, operation=null, searchController, searchGeneration=0, searchQuery='', searchResults=null;
let exportController, editorHistory=null, restoringHistory=false, undoButton, redoButton, draggedBlockId=null;
let blockDnd=null,blockDndGeneration=0;
let collectionView=null,collectionViewId=validId(new URL(location.href).searchParams.get('view'))?new URL(location.href).searchParams.get('view'):null,collectionRecovery=false,collectionRefresh=false;
const collectionActivities=new Set();
const blockSelection={scope:null,mode:false,ids:new Set(),anchor:null};
let settingsDialog=null,workspacePicker=null,settingsPolicyChanged=false;
const collapsedTeamspaces=new Set(),expandedSidebarPages=new Set();
const modalOpen=()=>modal.open||settingsDialog?.open===true||workspacePicker?.open===true;
let room=null; const roomCompositions=new Set();
const presence=createWorkspacePresence({app,getRoom:()=>room,getCurrent:()=>state.current,isComposing:()=>roomCompositions.size>0,isModalOpen:modalOpen,translate:(...args)=>t(...args),onAuthorizationFailure:active=>stopRoomInput(active)});
let bodySaveTask=null, bodySaveBlocked='', draftGeneration=0, observedDraft='';
const autosave=new PageAutosave({
  getState:()=>({scopeKey:state.current&&state.user?JSON.stringify([state.user.id,workspaceId,state.current.page.id,state.selection]):null,
    generation:draftGeneration,dirty:bodyDirty(),paused:!canEdit()||state.busy||state.loading||state.listLoading||!!room||modalOpen()||roomCompositions.size>0||state.conflict||!!bodySaveBlocked||!!draggedBlockId||collectionActivities.size>0}),
  save:context=>persistPage(context),onState:()=>refreshSaveStatus()
});
const t = (key, values) => i18n ? i18n.t(key, values) : key;
const fieldT = (key, values) => fieldI18n ? fieldI18n.t(key, values) : key;
function node(tag, attrs = {}, children = []) {
  const result = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on')) result.addEventListener(name.slice(2).toLowerCase(), value);
    else if (['value', 'disabled', 'required', 'checked', 'readOnly'].includes(name)) result[name] = value;
    else if (name === 'class') result.className = value;
    else result.setAttribute(name, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== null && child !== undefined) result.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return result;
}
function icon(name) {
  const paths = { grip: 'M9 5h.01 M15 5h.01 M9 12h.01 M15 12h.01 M9 19h.01 M15 19h.01', page: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7',
    plus: 'M12 5v14 M5 12h14', menu: 'M4 6h16 M4 12h16 M4 18h16',
    undo: 'M4 8h9a7 7 0 0 1 0 14 M4 8l5-5 M4 8l5 5', redo: 'M20 8h-9a7 7 0 0 0 0 14 M20 8l-5-5 M20 8l-5 5', close: 'M6 6l12 12 M18 6L6 18', refresh: 'M20 7v5h-5 M19 12a7 7 0 1 1-2-6',
    account: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6', more: 'M5 12h.01 M12 12h.01 M19 12h.01', inbox: 'M4 4h16v16H4z M4 13h5l2 3h2l2-3h5',
    search: 'M21 21l-6-6 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0', trash: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7', download: 'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4', arrow: 'M5 12h14 M13 6l6 6-6 6' };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] || paths.page); svg.append(path); return svg;
}
function button(key, handler, options = {}) {
  return node('button', { type: 'button', class: 'button' + (options.primary ? ' primary' : '') + (options.class ? ' ' + options.class : ''),
    disabled: options.disabled, title: options.title, onClick: handler, ...(options.label ? { 'aria-label': options.label } : {}) },
  options.icon ? [icon(options.icon), ...(options.iconOnly ? [] : [node('span', {}, t(key))])] : t(key));
}
function canEdit() { return !!state.current?.page.capabilities?.includes('editBody') && !state.locked && !(room?.phase==='ready' && room.client?.editable===false); }
function editingDisabled() { return !canEdit() || state.busy || state.loading || state.listLoading || !!room && room.phase!=='ready'; }
function structureDisabled() { return editingDisabled() || !!room&&room.client?.protocol!==2 || roomCompositions.size > 0; }
function bodyDirty() {
  if (!state.current || !state.draft) return false;
  return state.draft.title !== state.current.page.title || !pageBlocksEqual(state.draft.blocks,state.current.document.blocks);
}
function updateDirty(historyGroup=null) {
  if(editorHistory && state.draft && !restoringHistory && !room) {try {editorHistory.record(state.draft,{group:historyGroup,selection:editorSelection() || editorHistory.current.selection});}catch {editorHistory=null;state.error='historyUnavailable';}}
  if(undoButton)undoButton.disabled=structureDisabled() || !(room?room.client?.canUndo:editorHistory?.canUndo);
  if(redoButton)redoButton.disabled=structureDisabled() || !(room?room.client?.canRedo:editorHistory?.canRedo);
  state.dirty = bodyDirty() || state.collection?.dirty === true || room?.client?.pending === true;
  const signature=state.draft?JSON.stringify(state.draft):'';
  if(signature!==observedDraft){observedDraft=signature;draftGeneration++;autosave.notify();}else autosave.refresh();
  refreshSaveStatus();
  refreshRoomStatus();
}
function refreshSaveStatus() {
  if(saveButton)saveButton.disabled=!bodyDirty()||editingDisabled()||roomCompositions.size>0||state.conflict||!!bodySaveBlocked||!!bodySaveTask||!!room||!!draggedBlockId;
  const status=room?t(roomStatusKey()):!state.current?'':t(bodySaveTask?'saving':bodySaveBlocked==='unknown'?'saveUnknownStatus':state.conflict?'saveConflictStatus':bodySaveBlocked?'savePaused':!canEdit()?'readOnly':bodyDirty()?'autoSavePending':state.collection?.dirty?'propertyDraftPending':'autoSaved');
  if(saveStatus&&saveStatus.textContent!==status)saveStatus.textContent=status;
  const crumb=app.querySelector('[data-page-crumb]');if(crumb&&state.draft)crumb.textContent=state.draft.title||t('untitled');
}
async function settleBodySave(){if(bodySaveTask)await bodySaveTask;return !state.conflict&&!bodySaveBlocked&&!state.locked;}
function refreshPageFeedback(){
  const host=app.querySelector('[data-page-feedback]');if(!host)return;
  host.replaceChildren();
  if(state.conflict||bodySaveBlocked){host.append(node('div',{class:'conflict-note',role:'alert'},[
    node('strong',{},t(state.conflict?'conflictTitle':'savePaused')),
    node('p',{},t(bodySaveBlocked==='unknown'?'saveUnknown':state.conflict?'conflict':state.error||'saveFailed')),
    button('reload',()=>void reloadPage(),{disabled:state.busy||state.loading||!!bodySaveTask})
  ]));}
  else if(state.error||state.notice)host.append(node('p',{class:'message'+(state.error?' is-error':''),role:state.error?'alert':'status'},t(state.error||state.notice,state.noticeValues)));
}
function applyPreferences() {
  const pref = resolveAppearancePreferences(preferences.snapshot());
  const colors = validateCustomColors(pref.themeId, pref.customColors).colors || THEMES.find(item => item.id === 'light').colors;
  for (const [key, value] of Object.entries(colors)) document.documentElement.style.setProperty('--' + key, value);
  document.documentElement.style.fontFamily = FONT_OPTIONS.find(item => item.id === pref.fontId)?.family || FONT_OPTIONS[0].family;
  const hex = colors.canvas.slice(1);
  const brightness = [0, 2, 4].reduce((sum, start, index) => sum + parseInt(hex.slice(start, start + 2), 16) * [0.2126, 0.7152, 0.0722][index], 0);
  document.documentElement.style.colorScheme = brightness < 128 ? 'dark' : 'light';
  i18n?.setLocale(pref.locale); fieldI18n?.setLocale(pref.locale);
  applyLocaleDocument(document, i18n, { additional: fieldI18n ? [fieldI18n] : [] });
  document.querySelector('meta[name="theme-color"]').content = colors.nav;
  document.querySelector('.skip-link').textContent = t('skip');
  workspaceBrand?.apply({kind:document.documentElement.style.colorScheme});
}
class ApiError extends Error {
  constructor(status, code) { super(code || 'REQUEST_FAILED'); this.status = status; this.code = code; }
}
async function request(path, { method = 'GET', body, signal, headers: extraHeaders = {} } = {}) {
  const timeout = AbortSignal.timeout(15000);
  let response;
  try {
    response = await fetch(path, { method, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { ...(state.user?.id ? { 'X-Yumunio-Expected-Account': state.user.id } : method === 'GET' ? {} : { 'X-Yumunio-Expected-Account': '' }), ...extraHeaders, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) { if (signal?.aborted) throw error; throw new ApiError(0, 'NETWORK_FAILED'); }
  let data; try { data = await response.json(); } catch { throw new ApiError(0, 'INVALID_RESPONSE'); }
  if (!response.ok) throw new ApiError(response.status, data?.error?.code);
  return data;
}
function roomStatusKey() {
 if(!room)return 'roomOff';
 if(room.phase==='opening')return 'roomOpening';
 if(room.phase==='review')return 'roomReviewRequired';
 if(room.phase==='syncing')return 'roomSyncing';
 if(room.phase==='paused')return 'roomPaused';
 if(room.phase==='stopped')return 'roomStopped';
 if(room.renewing)return 'roomRenewing';
 if(room.renewalError)return 'roomRenewRetry';
 if(room.syncing)return 'roomSyncing';
 if(room.syncError)return 'roomSyncRetry';
 if(room.deferred)return 'roomWaitingInput';
 return room.client?.pending?'roomPending':room.client?.editable===false?'roomReadOnly':'roomSynced';
}
function refreshRoomStatus() {
 if(room?.client?.operationConflicts?.length){state.notice='roomOperationConflict';refreshPageFeedback();}
 const status=app.querySelector('.room-status');if(status)status.textContent=t(roomStatusKey());
 if(room && saveStatus)saveStatus.textContent=t(roomStatusKey());
 if(room && ['ready','paused'].includes(room.phase))for(const control of app.querySelectorAll('.room-controls button'))control.disabled=state.busy || room.client?.busy || room.renewing || room.syncing;
}
function destroyRoom() {if(!room)return;presence.leave(room);clearTimeout(room.timer);room.client?.destroy();room=null;roomCompositions.clear();}
function stopRoomInput(active) {
 if(room!==active)return;
 presence.leave(active);active.phase='stopped';active.client?.stop();clearTimeout(active.timer);state.notice='roomInputStopped';
 if(roomCompositions.size)active.renderAfterComposition=true;else render();
}
async function renewRoom(active) {
 if(room!==active || active.phase!=='ready' || !active.client || active.client.busy)return;
 if(active.renewPromise)return active.renewPromise;
 active.renewing=true;refreshRoomStatus();
 active.renewPromise=(async()=>{
  try {
   await active.client.renew();
   if(room===active){active.renewalError=false;}
  } catch(error) {
   if(room!==active)return;
   if(active.client.status==='stale' || [401,403,404].includes(error.status) || error.code==='ROOM_NOT_EDITABLE') {
    stopRoomInput(active);
   } else active.renewalError=true;
  } finally {
   active.renewing=false;active.renewPromise=null;
   if(room===active)refreshRoomStatus();
  }
 })();
 return active.renewPromise;
}
function scheduleRoomPoll() {
 if(!room)return;clearTimeout(room.timer);const active=room;
 if(active.phase!=='ready')return;
 active.timer=setTimeout(async()=> {
  if(room!==active || active.phase!=='ready')return;
  if(!document.hidden && !state.loading && !active.client.busy && active.client.ticketRenewalDue())await renewRoom(active);
  if(room!==active || active.phase!=='ready')return;
  if(!document.hidden && !modalOpen() && !state.busy && !state.loading && !state.listLoading && !roomCompositions.size)await syncRoom(false);
  if(room===active){await presence.publish(active);scheduleRoomPoll();}
 },3000);
}
function recordRoomText(key,value,change) {
 if(!room || room.phase!=='ready')return;
 room.lastSelection=editorSelection() || room.lastSelection;
 try {room.client.setText(key,value,{marks:change?.marks??[]});presence.changed();}
 catch {stopRoomInput(room);}
}
function roomEnvelope(base,draft,client) {
 if(!Number.isSafeInteger(client.revision) || !Number.isSafeInteger(client.documentVersion) || client.documentVersion<1)throw new ApiError(0,'INVALID_ROOM_RESPONSE');
 return {...base,revision:client.revision,page:{...base.page,title:draft.title,version:client.documentVersion,capabilities:client.editable===false?base.page.capabilities.filter(value=>value!=='editBody'):base.page.capabilities},document:{...base.document,version:client.documentVersion,blocks:clone(draft.blocks)}};
}
function applyRoomDraft(active,draft,{focus=false}={}) {
 const selection=mapRoomSelection(state.draft,draft,active.lastSelection);
 state.current=roomEnvelope(active.base,draft,active.client);state.draft=clone(draft);active.base=state.current;active.lastSelection=selection;
 const page=state.pages.find(item=>item.id===state.current.page.id);if(page){page.title=draft.title;page.version=active.client.documentVersion;}
 editorHistory=new EditorHistory(state.draft);state.conflict=false;render();
 if(focus && selection)requestAnimationFrame(()=> {
  if(selection.title){const input=document.getElementById('page-title');input?.focus();input?.setSelectionRange(selection.start,selection.end);}
  else if(selection.blockId)focusBlock(selection.blockId,selection.start,selection.end);
 });
}
function activateRoom(active) {if(room!==active)return;active.phase='ready';applyRoomDraft(active,active.client.snapshot());scheduleRoomPoll();void presence.publish(active,{force:true});}
function showRoomStart() {
 if(!state.current || room || state.busy)return;
 const blocked=state.dirty || state.conflict;
 showModal('roomTitle',[node('p',{},t('roomIntro')),node('p',{class:'hint'},t('roomFocusPolicy')),node('p',{class:'hint'},t('roomPresenceIntro')),
  ...(blocked?[node('p',{class:'message'},t('roomSaveFirst'))]:[]),node('div',{class:'dialog-actions'},[
   button('cancel',()=>modal.close()),button('roomStart',()=>void startRoom(),{primary:true,disabled:blocked})
  ])]);
}
async function startRoom() {
 if(collectionActivities.size)return;
 if(!await settleBodySave())return;
 if(room || state.busy || state.dirty || state.conflict || !state.current)return;
 const openingScope=blockDragScope();await closeModalFully();if(room||state.busy||modalOpen()||openingScope!==blockDragScope())return;const pageId=state.current.page.id,marker=state.selection;
 const active={phase:'opening',client:null,base:null,lastSelection:editorHistory?.current.selection || null,timer:null};room=active;state.busy=true;render();
 try {
  const fresh=validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(pageId)),pageId);
  const {HttpRoomClient}=await import('./shared/collaboration-client.js');
  if(room!==active || marker!==state.selection)return;
  active.base=fresh;active.client=new HttpRoomClient({accountId:state.user.id,workspaceId,pageId,draft:{title:fresh.page.title,blocks:fresh.document.blocks},protocol:2,request:call=>request(call.path,call)});
  await active.client.open({expectedRevision:fresh.revision});
  if(room!==active || marker!==state.selection)return;
  const incoming=active.client.snapshot();state.busy=false;
  if(JSON.stringify(incoming)!==JSON.stringify(state.draft)) {
   active.phase='review';render();showModal('roomReviewTitle',[node('p',{},t('roomReviewIntro')),node('div',{class:'room-review'},[
    node('section',{},[node('h3',{},t('roomCurrent')),node('strong',{translate:'no'},state.draft.title),node('pre',{translate:'no'},roomTextPreview(state.draft))]),
    node('section',{},[node('h3',{},t('roomIncoming')),node('strong',{translate:'no'},incoming.title),node('pre',{translate:'no'},roomTextPreview(incoming))])
   ]),node('div',{class:'dialog-actions'},[button('cancel',()=>{destroyRoom();modal.close();render();}),button('roomApplyIncoming',()=>{modal.close();activateRoom(active);},{primary:true})])]);
  } else activateRoom(active);
 } catch {if(room===active){destroyRoom();state.error='roomStartFailed';}}
 finally{state.busy=false;render();}
}
function roomTextPreview(draft,limit=3000) {
 const texts=[];const visit=items=>{for(const block of items){if(typeof block.data?.text==='string')texts.push(block.data.text);if(block.children)visit(block.children);}};visit(draft.blocks);return texts.join('\n\n').slice(0,limit);
}
function prepareRoomApply(active,draft) {
 if(room!==active || active.phase!=='ready' || modalOpen() || state.busy || state.loading || roomCompositions.size || draggedBlockId || wideBlockSelection())return null;
 const before=indexEditorBlocks(state.draft.blocks),after=indexEditorBlocks(draft.blocks);
 let structural=before.size!==after.size;
 for(const[id,old]of before){const next=after.get(id);if(!next || old.block.type!==next.block.type || old.parentId!==next.parentId || old.index!==next.index || Object.hasOwn(old.block,'children')!==Object.hasOwn(next.block,'children'))structural=true;}
 if(structural&&active.client.protocol!==2)return null;
 const checks=structural?[]:prepareRoomCheckboxPatch(app,before,after);if(!checks)return null;
 const title=document.getElementById('page-title');if(!title || title.value!==state.draft.title)return null;
 const patches=[];
 for(const input of app.querySelectorAll('.inline-editor')) {
  const old=before.get(input.dataset.blockId)?.block,next=after.get(input.dataset.blockId)?.block;
  if(!old || typeof old.data?.text!=='string')continue;
  if(!next){if(!preflightInlineEditorPatch(input,{text:old.data.text,marks:old.data.marks||[],links:readableLinks(old.data),mentions:old.data.mentions||[]},{expectedText:old.data.text}).ready)return null;continue;}
  if(typeof next.data?.text!=='string')return null;
  const snapshot={text:next.data.text,marks:next.data.marks||[],links:readableLinks(next.data),mentions:next.data.mentions||[]};
  if(!preflightInlineEditorPatch(input,snapshot,{expectedText:old.data.text}).ready)return null;
  patches.push({input,snapshot,expectedText:old.data.text,blockId:old.id});
 }
 const focused=document.activeElement;
 let selection=null,key=null;
 if(focused===title){key='title';selection={start:title.selectionStart,end:title.selectionEnd,direction:title.selectionDirection||'none'};}
 else if(focused?.classList.contains('inline-editor') && focused.dataset.pageId===state.current?.page.id) {
  key='block:'+focused.dataset.blockId;selection=captureInlineSelection(focused);
  const range=document.getSelection();if(selection){const end=range?.rangeCount?range.getRangeAt(0):null;selection.direction=end&&!range.isCollapsed&&range.anchorNode===end.endContainer&&range.anchorOffset===end.endOffset?'backward':'forward';}
 }
 const marker=key&&selection?active.client.captureRelativeSelection({key,...selection}):null;
 if(key&&!marker)return null;
 const scroll=app.querySelector('.workspace-scroll');
 return {draft:JSON.stringify(draft),structural,before,after,checks,patches,title,focused,marker,key,scroll,scrollTop:scroll?.scrollTop,scrollLeft:scroll?.scrollLeft,fieldTop:focused?.scrollTop,fieldLeft:focused?.scrollLeft};
}
function applyRoomInPlace(active,draft,plan) {
 if(room!==active || !plan || plan.draft!==JSON.stringify(draft) || roomCompositions.size)throw new ApiError(0,'INVALID_ROOM_DOM');
 if(plan.structural){
  const selection=plan.marker?active.client.resolveRelativeSelection(plan.marker):null;
  state.draft=clone(draft);state.current=roomEnvelope(active.base,draft,active.client);active.base=state.current;state.conflict=false;
  const page=state.pages.find(item=>item.id===state.current.page.id);if(page){page.title=draft.title;page.version=active.client.documentVersion;}
  render();const scroll=app.querySelector('.workspace-scroll');if(scroll){scroll.scrollTop=plan.scrollTop;scroll.scrollLeft=plan.scrollLeft;}
  if(selection?.key==='title'){const title=document.getElementById('page-title');title?.focus({preventScroll:true});title?.setSelectionRange(selection.start,selection.end,selection.direction);}
  else if(selection){const id=selection.key.slice(6);if(blockLocation(id))focusBlock(id,selection.start,selection.end);else{const fallback=[...plan.before.keys()].find(key=>plan.after.has(key)&&typeof plan.after.get(key).block.data?.text==='string');if(fallback)focusBlock(fallback);else focusContent();}}
  return;
 }
 if(!applyRoomCheckboxPatch(plan.checks))throw new ApiError(0,'INVALID_ROOM_DOM');
 for(const {input,snapshot,expectedText}of plan.patches)if(!patchInlineEditor(input,snapshot,{expectedText}).applied)throw new ApiError(0,'INVALID_ROOM_DOM');
 plan.title.value=draft.title;autoSize(plan.title);
 // Existing input callbacks close over these block objects. Preserve that graph.
 state.draft.title=draft.title;
 for(const[id,location]of plan.before){const data=plan.after.get(id).block.data;if(data===undefined)delete location.block.data;else location.block.data=clone(data);}
 state.current=roomEnvelope(active.base,state.draft,active.client);active.base=state.current;
 const page=state.pages.find(item=>item.id===state.current.page.id);if(page){page.title=draft.title;page.version=active.client.documentVersion;}
 for(const {blockId}of plan.patches){const row=[...app.querySelectorAll('.block-row')].find(item=>item.dataset.blockId===blockId);if(row)refreshBlockLinks(row,plan.before.get(blockId).block);}
 const crumb=app.querySelector('.breadcrumb span:last-child');if(crumb)crumb.textContent=draft.title||t('untitled');
 const selected=app.querySelector('.page-link.selected span');if(selected)selected.textContent=draft.title||t('untitled');
 const version=app.querySelector('[data-document-version]');if(version)version.textContent=t('version',{version:active.client.documentVersion});
 workspaceBrand?.apply({kind:document.documentElement.style.colorScheme,titleSuffix:'',pageTitle:draft.title||t('untitled')});
 if(plan.focused===document.activeElement && plan.marker) {
  const selection=active.client.resolveRelativeSelection(plan.marker);
  if(selection?.key==='title')plan.title.setSelectionRange(selection.start,selection.end,selection.direction);
  else if(selection)setInlineSelection(plan.focused,{...selection,direction:selection.direction==='none'?'forward':selection.direction,focus:false,scroll:false});
 }
 if(plan.scroll){plan.scroll.scrollTop=plan.scrollTop;plan.scroll.scrollLeft=plan.scrollLeft;}
 if(plan.focused && Number.isFinite(plan.fieldTop)){plan.focused.scrollTop=plan.fieldTop;plan.focused.scrollLeft=plan.fieldLeft;}
 state.conflict=false;updateDirty();presence.refresh();
}
async function syncRoom(manual=true,stopAfter=false) {
 const active=room;if(!active?.client || !['ready','paused'].includes(active.phase) || state.busy || roomCompositions.size)return;
 if(active.renewPromise)await active.renewPromise;
 if(room!==active || !['ready','paused'].includes(active.phase) || active.client.busy || state.busy || roomCompositions.size)return;
 if(!state.draft.title.trim()){if(manual){state.error='titleRequired';render();}return;}
 if(active.phase==='paused'){active.phase='ready';render();}
 clearTimeout(active.timer);active.syncing=true;active.syncError=false;active.deferred=false;refreshRoomStatus();
 try {
  let prepared=null;
  const result=await active.client.sync({
   canApply:({draft})=>{prepared=prepareRoomApply(active,draft);return!!prepared;},
   onApply:({draft})=>{applyRoomInPlace(active,draft,prepared);prepared=null;}
  });
  if(room!==active)return;
  active.deferred=result.deferred===true;
  if(stopAfter && !active.deferred && !active.client.pending)await finishRoomStop(active);
 } catch(error) {
  if(room!==active)return;
  if(active.client.status!=='ready' || [401,403,404].includes(error.status) || ['ROOM_NOT_EDITABLE','ROOM_TOO_LARGE','ROOM_CAPACITY','INVALID_ROOM_DOM'].includes(error.code))stopRoomInput(active);
  else active.syncError=true;
 } finally {
  active.syncing=false;
  if(room===active){refreshRoomStatus();scheduleRoomPoll();}
 }
}
async function finishRoomStop(active) {
 if(room!==active || active.client?.pending || bodyDirty())return;
 const pageId=state.current?.page.id;if(!pageId)return;
 destroyRoom();state.collection=null;state.collectionError='';state.people=[];
 state.busy=false;
 await selectPage(pageId,true,true);
 if(state.current?.page.id===pageId && !state.error)state.notice='roomStoppedClean';
 render();void refreshList();
}
function stopRoom() {
 if(!room || state.busy)return;
 const active=room;
 if(!active.client?.pending && !bodyDirty()) {void finishRoomStop(active);return;}
 showModal('roomStopTitle',[node('p',{},t('roomStopPending')),node('div',{class:'dialog-actions'},[
  button('cancel',()=>modal.close()),button('roomKeepAndStop',()=>{presence.leave(active);active.client?.stop();active.phase='stopped';clearTimeout(active.timer);modal.close();render();}),
  button('roomSyncAndStop',async()=>{await closeModalFully();await syncRoom(true,true);},{primary:true,disabled:active.client?.status!=='ready'})
 ])]);
}
function showRoomInput() {
 if(!state.draft)return;const value=state.draft.title+'\n\n'+roomTextPreview(state.draft,Infinity);
 const field=node('textarea',{class:'room-copy-input',readOnly:true,rows:12,'aria-label':t('roomHeldInput'),value});
 showModal('roomHeldInput',[node('p',{},t('roomCopyHint')),field,button('roomHeldJson',downloadRoomDraft)]);field.focus();field.select();
}
function downloadRoomDraft(){if(!state.draft)return;const url=URL.createObjectURL(new Blob([JSON.stringify({format:'yumunio-held-draft',version:1,pageId:state.current?.page.id,draft:clone(state.draft)},null,2)],{type:'application/json'})),link=node('a',{href:url,download:'yumunio-held-draft.json'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function resetStructuredRoom(){
 const previous=room,scope=blockDragScope();if(!previous||previous.client?.protocol!==2||state.busy)return;
 showModal('roomReset',[node('p',{},t('roomResetConfirm')),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),button('roomHeldJson',downloadRoomDraft),button('roomReset',async()=>{
  if(room!==previous||scope!==blockDragScope()||state.busy)return;state.busy=true;for(const button of modal.querySelectorAll('button'))button.disabled=true;
  let client;
  try{const pageId=state.current.page.id,fresh=validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(pageId)),pageId),{HttpRoomClient}=await import('./shared/collaboration-client.js');if(room!==previous||scope!==blockDragScope())return;client=new HttpRoomClient({accountId:state.user.id,workspaceId,pageId,draft:{title:fresh.page.title,blocks:fresh.document.blocks},protocol:2,request:call=>request(call.path,call)});await client.open({expectedRevision:fresh.revision,reset:true});if(room!==previous||scope!==blockDragScope())return;destroyRoom();room={phase:'ready',client,base:fresh,lastSelection:null,timer:null};client=null;state.busy=false;modal.close();activateRoom(room);
  }catch{state.error='roomStartFailed';stopRoomInput(previous);if(modal.dataset.view==='roomReset')modal.close();}finally{client?.destroy();state.busy=false;render();}
 },{primary:true})])]);
}
function renderRoomPanel() {
 if(!room)return node('div',{class:'room-start-line'},[node('span',{},t('roomTitle')),button('roomStart',showRoomStart,{disabled:state.busy || state.loading || state.listLoading})]);
 const controls=[];
 if(!room)controls.push(button('roomStart',showRoomStart,{disabled:state.busy || state.loading || state.listLoading}));
 else if(room.phase==='ready' || room.phase==='paused')controls.push(button(room.phase==='paused'?'roomRetry':'roomSync',()=>void syncRoom(),{disabled:state.busy}),button('roomStop',stopRoom,{disabled:state.busy}));
 else if(room.phase==='stopped')controls.push(button('roomHeldInput',showRoomInput),button('roomReset',resetStructuredRoom,{disabled:state.busy||room.client?.protocol!==2}),button('roomReload',()=>void reloadPage(),{disabled:state.busy}));
 return node('section',{class:'room-panel','aria-label':t('roomTitle')},[node('div',{class:'room-panel-heading'},[node('strong',{},t('roomTitle')),node('span',{class:'room-status',role:'status','aria-live':'polite'},t(roomStatusKey()))]),node('p',{class:'hint'},t(['paused','stopped'].includes(room.phase)?'roomStoppedHint':'roomFocusPolicy')),
  ...(room && ['paused','stopped'].includes(room.phase)?[node('p',{class:'room-error',role:'status'},t('roomInputStopped'))]:[]),node('div',{'data-room-presence':''}),node('div',{class:'room-controls'},controls)]);
}

const basePath = () => '/api/content/workspaces/' + encodeURIComponent(workspaceId) + '/pages';
function errorKey(error, fallback) {
  if (error.status === 401) { state.locked = true; return 'unauthorized'; }
  if ([403, 404].includes(error.status)) { state.locked = true; return state.current ? 'forbidden' : 'notFound'; }
  if (error.status === 413) return 'tooLarge';
  if (error.status === 400) return 'invalidContent';
  if (error.status === 409) { state.conflict = true; return 'conflict'; }
  return fallback;
}
function validatePageEnvelope(data, pageId) {
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 || data.page?.id !== pageId ||
      data.page.workspaceId !== workspaceId || !Array.isArray(data.page.capabilities) || !data.page.capabilities.includes('read') ||
      typeof data.page.title !== 'string' || data.document?.pageId !== pageId || data.document.workspaceId !== workspaceId ||
      !Number.isSafeInteger(data.document.version) || data.document.version < 1 || !Array.isArray(data.document.blocks)) throw new ApiError(0, 'INVALID_RESPONSE');
  try { validateInlineBlockMetadata(data.document.blocks); } catch { throw new ApiError(0,'INVALID_RESPONSE'); }
  return data;
}
function showModal(title, content, { cancelLabel = 'close' } = {}) {
  blockDnd?.cancel();
  collectionView?.cancel();
  modal.dataset.view=title; modal.className=['searchPages','trashPages','exportWorkspace'].includes(title)?'wide-dialog':'';
  if (modal.open) modal.close();
  modal.replaceChildren(node('header', { class: 'dialog-header' }, [
    node('h2', { id: 'workspace-modal-heading' }, t(title)),
    button(cancelLabel, () => modal.close(), { icon: 'close', iconOnly: true, label: t(cancelLabel), class: 'icon-button' })
  ]), node('div', { class: 'dialog-body' }, content));
  modal.showModal();
  autosave.refresh();
}
async function closeModalFully() {
  if(!modal.open)return;
  await new Promise(resolve=> { modal.addEventListener('close',resolve,{once:true});modal.close(); });
}
async function confirmReplace(reload = false) {
  if(collectionActivities.size)return false;
  await settleBodySave();
  if(!reload&&!modalOpen()&&!bodySaveBlocked&&!state.conflict&&!room){await autosave.flush();updateDirty();}
  if (!state.dirty&&!bodySaveBlocked) return true;
  await closeModalFully();
  return new Promise(resolve => {
    let confirmed = false;
    showModal(reload ? 'confirmReloadTitle' : 'confirmDiscardTitle', [
      node('p', {}, t(reload ? 'confirmReload' : 'confirmDiscard')),
      node('div', { class: 'dialog-actions' }, [
        button('cancel', () => modal.close()),
        button(reload ? 'reloadContinue' : 'discard', () => { confirmed = true; modal.close(); }, { primary: true })
      ])
    ]);
    modal.addEventListener('close', () => resolve(confirmed), { once: true });
  });
}
function setNavigation(open) {
  state.navOpen = open; app.classList.toggle('nav-open', open);
  if (navButton) navButton.setAttribute('aria-expanded', String(open));
  const mobile = matchMedia('(max-width: 760px)').matches;
  if (mainPanel) mainPanel.inert = open && mobile;
  if (sidebar) sidebar.inert = !open && mobile;
  if (open) sidebar?.querySelector('button,a')?.focus(); else navButton?.focus();
}
function autoSize(input) { input.style.height = 'auto'; input.style.height = Math.max(40, input.scrollHeight) + 'px'; }
function focusContent() { document.getElementById('page-title')?.focus(); }
function render() {
  queueMicrotask(presence.refresh);
  collectionView?.destroy();collectionView=null;
  const dndGeneration=++blockDndGeneration;
  blockDnd?.destroy();blockDnd=null;draggedBlockId=null;syncBlockSelection();
  const active = document.activeElement;
  const inlineSelection = active?.classList?.contains('inline-editor') && active.dataset.pageId === state.current?.page.id ? captureInlineSelection(active) : null;
  const inlineBlockId = inlineSelection ? active.dataset.blockId : null;
  const tableSelection=active?.classList?.contains('simple-table-cell')&&active.dataset.pageId===state.current?.page.id?editorSelection():null;
  app.className = 'workspace-shell' + (state.navOpen ? ' nav-open' : '');
  app.replaceChildren();
  sidebar = node('aside', { class: 'workspace-sidebar', 'aria-label': t('pages') });
  const workspaceName = state.name || t('serverWorkspace');
  const brandMark=icon('page');brandMark.setAttribute('data-instance-default-logo','');
  sidebar.append(node('div', { class: 'workspace-brand' }, [node('button',{type:'button',class:'workspace-switcher','aria-label':t('workspacePicker.title'),onClick:openWorkspacePicker,disabled:!state.user||!!state.fatal||state.busy},[node('img',{'data-instance-logo':'',alt:'',width:'22',height:'22',hidden:true}),brandMark,node('span',{translate:'no'},workspaceName),node('span',{'aria-hidden':'true'},'⌄')]),
    button('closeMenu', () => setNavigation(false), { icon: 'close', iconOnly: true, label: t('closeMenu'), class: 'mobile-close icon-button' })]));
  sidebar.append(node('nav', { class: 'workspace-links', 'aria-label': t('pages') }, [
    button('sidebarSearch',openSearch,{icon:'search',class:'nav-link sidebar-search',disabled:!state.user||!!state.fatal||state.busy}),
    button('sidebarHome',()=>void openWorkspaceHome(),{icon:'page',class:'nav-link',disabled:!state.user||!!state.fatal||state.busy}),
    ...(state.user&&!state.fatal?[node('a',{href:'/comments.html?workspace='+encodeURIComponent(workspaceId),class:'nav-link'},[icon('inbox'),t('sidebarInbox')])]:[]),
    node('details',{class:'sidebar-library'},[node('summary',{},[icon('page'),t('sidebarLibrary')]),node('div',{class:'sidebar-library-links'},[
      node('a',{href:'/collections.html?workspace='+encodeURIComponent(workspaceId),class:'nav-link'},[icon('page'),t('collections')]),
      node('a',{href:'/forms.html?workspace='+encodeURIComponent(workspaceId),class:'nav-link'},[icon('page'),t('forms')]),
      ...(state.role&&state.role!=='guest'?[node('a',{href:'/templates.html?workspace='+encodeURIComponent(workspaceId),class:'nav-link'},[icon('page'),t('personalTemplates')])]:[])
    ])])
  ]));
  const newDisabled = !!room || !state.user || state.fatal || state.role === 'guest' || state.busy || state.listLoading || state.locked;
  sidebar.append(node('div', { class: 'page-list-heading' }, [
    node('span', {}, t('pages')),
    button('refreshList', () => void refreshList(true), { icon: 'refresh', iconOnly: true, label: t('refreshList'), class: 'icon-button', disabled: !state.user || state.busy || state.listLoading || !!state.fatal }),
    button('createPage', () => void openCreate(), { icon: 'plus', iconOnly: true, label: t('createPage'), class: 'icon-button', disabled: !!newDisabled, title: t(state.role === 'guest' ? 'limitedCreate' : 'createPage') })
  ]));
  const list = node('div', { class: 'page-list page-directory' });
  const pageLists=new Map();
  const group=(key,label,controls=[])=>{const section=node('section',{class:'sidebar-page-section'}),heading=node('div',{class:'page-list-heading'},[node('span',{},label),...controls]),items=node('ul',{class:'sidebar-section-pages'});section.append(heading,items);list.append(section);pageLists.set(key,items);return{section,heading,items};};
  const activeTeams=state.teamspaces.filter(team=>team.role!==null&&!team.archivedAt);
  if(state.teamsAvailable){
   group('personal',t('teamspaces.personalPages'));
   const teamHeader=node('div',{class:'page-list-heading'},[node('span',{},t('teamspaces.title')),button('teamspaces.browse',()=>openSettings('teamspaces'),{icon:'more',iconOnly:true,label:t('teamspaces.browse'),class:'icon-button',disabled:!state.user||state.busy})]);list.append(teamHeader);
   for(const team of activeTeams){
    const item=group('team:'+team.id,team.name,[...(team.capabilities.includes('createPage')?[button('createPage',()=>void openCreate(team.id),{icon:'plus',iconOnly:true,label:t('createPage'),class:'icon-button',disabled:!!newDisabled})]:[]),button('teamspaces.settings',()=>openSettings('teamspaces',team.id),{icon:'more',iconOnly:true,label:t('teamspaces.settings')+' · '+team.name,class:'icon-button',disabled:state.busy})]);
    item.heading.replaceChild(node('button',{type:'button',class:'teamspace-disclosure','aria-expanded':String(!collapsedTeamspaces.has(team.id)),onClick:()=>{if(collapsedTeamspaces.has(team.id))collapsedTeamspaces.delete(team.id);else collapsedTeamspaces.add(team.id);render();}},[node('span',{'aria-hidden':'true'},collapsedTeamspaces.has(team.id)?'›':'⌄'),node('span',{translate:'no'},team.name)]),item.heading.firstChild);
    item.items.hidden=collapsedTeamspaces.has(team.id);
   }
  }
  const destinationList=page=>{
   const team=page.teamspaceId&&activeTeams.find(item=>item.id===page.teamspaceId);
   const key=team?'team:'+team.id:page.sidebarSection==='personal'?'personal':page.sidebarSection==='shared'||page.sidebarSection==='teamspace'?'shared':'legacy';
   if(!pageLists.has(key))group(key,t(key==='personal'?'teamspaces.personalPages':key==='shared'?'teamspaces.sharedPages':'pages'));
   return pageLists.get(key);
  };
  for (const {page,depth,hasChildren} of sidebarPageRows(state.pages,expandedSidebarPages)) {
    const pageButton = node('button', { type: 'button', class: 'page-link' + (state.current?.page.id === page.id ? ' selected' : ''),
      'data-dnd-page-id':!room && page.id!==state.current?.page.id && page.capabilities.includes('editBody')?page.id:null,
      disabled: state.busy, 'aria-current': state.current?.page.id === page.id ? 'page' : null,
      onClick: () => void selectPage(page.id), draggable:!room && state.role!=='guest' && page.capabilities.includes('manage') && !page.recordId && !state.busy,
      onDragStart:event=>startPageDrag(event,page),onDragEnd:endPageDrag,onDragOver:event=>overPageDrop(event,page.id),onDragLeave:event=>event.currentTarget.classList.remove('drop-target'),onDrop:event=>dropPage(event,page.id) }, [icon('page'), node('span', { translate: 'no' }, page.title || t('untitled'))]);
    const row=node('li',{class:'sidebar-page-row'});row.style.paddingInlineStart=(depth*14)+'px';
    if(hasChildren)row.append(node('button',{type:'button',class:'sidebar-page-disclosure','aria-label':t(expandedSidebarPages.has(page.id)?'sidebarCollapse':'sidebarExpand',{name:page.title||t('untitled')}),'aria-expanded':String(expandedSidebarPages.has(page.id)),onClick:()=>{if(expandedSidebarPages.has(page.id))expandedSidebarPages.delete(page.id);else expandedSidebarPages.add(page.id);render();}},expandedSidebarPages.has(page.id)?'⌄':'›'));else row.append(node('span',{class:'sidebar-page-spacer','aria-hidden':'true'}));
    row.append(pageButton);destinationList(page).append(row);
  }
  sidebar.append(node('button',{type:'button',class:'root-drop-target',onDragOver:event=>overPageDrop(event,null),onDragLeave:event=>event.currentTarget.classList.remove('drop-target'),onDrop:event=>dropPage(event,null)},t('moveToRoot')),list,node('p', { class: 'sidebar-note' }, t('permissionNote')));
  sidebar.append(node('footer', { class: 'sidebar-footer' }, [
    ...(state.user&&!state.fatal?[node('a',{href:'/workspace-settings.html?workspace='+encodeURIComponent(workspaceId),class:'nav-link'},[icon('settings'),t('sidebarSettings')]),button('sidebarInvite',()=>openSettings('members'),{icon:'account',class:'nav-link',disabled:state.busy})]:[]),
    node('details',{class:'sidebar-library sidebar-tools'},[node('summary',{},[icon('more'),t('sidebarTools')]),node('div',{class:'sidebar-library-links'},[
      button('trashPages',()=>void openTrash(),{icon:'trash',class:'nav-link',disabled:!state.user||!!state.fatal||state.busy}),
      button('exportWorkspace',openExport,{icon:'download',class:'nav-link',disabled:!state.user||!!state.fatal||state.busy}),
      ...(state.user&&!state.fatal&&state.role&&state.role!=='guest'?[node('a',{href:'/workspace-settings.html?workspace='+encodeURIComponent(workspaceId)+'&section=import',class:'nav-link'},[icon('plus'),t('importContent')])]:[]),
      node('a',{href:'/',class:'nav-link'},[icon('arrow'),t('deviceNotes')]),
      node('a',{href:'/integrations.html?workspace='+encodeURIComponent(workspaceId)+(state.current?'&page='+encodeURIComponent(state.current.page.id):''),class:'nav-link'},t('integrations')),
      node('a',{href:'/install.html',class:'nav-link'},t('installApp')),
      node('a',{href:'./LICENSE.txt',class:'license-link'},t('footerLicense'))
    ])]),
    node('button',{type:'button',class:'profile-link',onClick:openWorkspacePicker,disabled:!state.user||state.busy},[node('span',{class:'profile-symbol','aria-hidden':'true'},Array.from(state.user?.name||'Y')[0]),node('span',{translate:'no'},state.user?.name||t('account'))])
  ]));
  const scrim = node('button', { type: 'button', class: 'nav-scrim', 'aria-label': t('closeMenu'), tabindex: '-1', onClick: () => setNavigation(false) });
  mainPanel = node('main', { class: 'workspace-main' });
  navButton = button('menu', () => setNavigation(!state.navOpen), { icon: 'menu', iconOnly: true, label: t('menu'), class: 'nav-toggle icon-button' });
  navButton.setAttribute('aria-expanded', String(state.navOpen));
  navButton.setAttribute('aria-controls', 'workspace-sidebar');
  sidebar.id = 'workspace-sidebar';
  saveStatus = node('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
  saveButton = button('save', () => void savePage(), { disabled: true, title:room?t('roomStopFirst'):undefined });
  undoButton=button('undo',()=>applyEditorHistory('undo'),{icon:'undo',iconOnly:true,label:t('undo'),class:'icon-button',disabled:true,title:room&&room.client?.protocol!==2?t('roomStopFirst'):undefined});
  redoButton=button('redo',()=>applyEditorHistory('redo'),{icon:'redo',iconOnly:true,label:t('redo'),class:'icon-button',disabled:true,title:room&&room.client?.protocol!==2?t('roomStopFirst'):undefined});
  const topbar = node('header', { class: 'workspace-topbar' }, [
    navButton, node('div', { class: 'breadcrumb' }, [node('span', { translate: 'no' }, workspaceName),
      ...(state.current ? [node('span', { class: 'breadcrumb-divider', 'aria-hidden': 'true' }, '/'), node('span', { translate: 'no','data-page-crumb':'' }, state.draft.title || t('untitled'))] : [])]),
    node('div', { class: 'topbar-actions' }, [saveStatus,undoButton,redoButton,
      button('shareResource',()=>openResourceSharing(),{class:'button quiet',disabled:!state.current?.page.capabilities?.some(value=>['manage','invite'].includes(value))||state.busy||state.loading}),
      ...(state.current?.page.capabilities?.includes('read')?[node('a',{href:'/backlinks.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(state.current.page.id),class:'button'},t('backlinks'))]:[]),
      button('pageActions',openPageActions,{icon:'more',iconOnly:true,label:t('pageActions'),class:'icon-button',disabled:!state.current || state.busy || state.loading}),
      button('reload', () => void reloadPage(), { icon: 'refresh', iconOnly: true, label: t('reload'), class: 'icon-button', disabled: !state.current || state.busy || state.loading }), saveButton])
  ]);
  const scroll = node('div', { class: 'workspace-scroll', 'data-locale-notice-host':'' });
  const content = node('section', { class: 'document-content' + (state.collection && !state.current?.page.recordId ? ' has-collection' : ''), id: 'workspace-document', tabindex: '-1', 'aria-label': t('currentPage') });
  if (state.fatal) {
    content.append(node('div', { class: 'empty-state' }, [icon('page'), node('h1', {}, t('title')), node('p', { role: 'status' }, t(state.fatal)),
      node('a', { class: 'button primary', href: '/account.html' }, t('openAccount'))]));
  } else if (!state.current) {
    content.append(node('p', { class: 'boundary-note' }, t('boundary')), node('div', { class: 'empty-state' }, [
      icon('page'), node('h1', {}, t(state.listLoading ? 'loading' : state.pages.length ? 'selectPage' : 'emptyTitle')),
      node('p', {}, t(state.role === 'guest' ? 'emptyGuest' : 'emptyIntro')),
      ...(state.role !== 'guest' ? [button('createPage', () => void openCreate(), { primary: true, icon: 'plus', disabled: !!newDisabled })] : [])
    ]));
  } else {
    content.append(renderRoomPanel(),node('div',{'data-page-feedback':''}));
    const title = node('textarea', { id: 'page-title', class: 'page-title', rows: '1', maxlength: '240', 'aria-label': t('pageTitle'), value: state.draft.title, disabled: editingDisabled(), onBeforeInput:rememberEditorSelection,
      onInput: event => { state.draft.title = event.target.value.replace(/[\r\n]/g, ' '); if (event.target.value !== state.draft.title) event.target.value = state.draft.title; autoSize(event.target); recordRoomText('title',state.draft.title); updateDirty('title'); } });
    title.addEventListener('compositionstart',()=>{roomCompositions.add('title');updateDirty();});title.addEventListener('compositionend',()=>{roomCompositions.delete('title');updateDirty();});
    content.append(title, node('div', { class: 'document-meta' }, [
      node('span', {}, t(room && room.phase!=='ready' ? 'readOnly' : canEdit() ? 'editAllowed' : 'readOnly')),
      node('span', {'data-document-version':''}, t('version', { version: state.current.document.version })),
      node('span', {}, t(room && ['paused','stopped'].includes(room.phase)?'roomStoppedSync':room?'roomLimitedSync':'autoSaveLabel'))
    ]));
    if (state.current.attachments?.length) content.append(renderPageAttachments());
    if (state.collection) content.append(renderCollection());
    if (state.collectionError) content.append(node('p',{class:'message',role:'status'},t(state.collectionError)));
    if(canEdit()&&(!room||room.client?.protocol===2))content.append(renderBlockSelectionToolbar());
    const blocks = node('div', { class: 'document-blocks' });
    const locations=indexEditorBlocks(state.draft.blocks),nestingPlanner=createEditorNestingPlanner(state.draft.blocks);
    state.draft.blocks.forEach(block => blocks.append(renderBlock(block, locations,nestingPlanner)));
    const last=state.draft.blocks.at(-1);
    if(!structureDisabled()&&!(last?.type==='paragraph'&&last.data?.text===''&&!last.children?.length))blocks.append(renderBodyEntry());
    const endDrop=node('div',{class:'block-end-drop'},t('dropBlockAtEnd'));blocks.append(endDrop);content.append(blocks);
    if (canEdit()) content.append(button('addBlock', () => openBlockPicker(), { icon: 'plus',iconOnly:true,label:t('addBlock'), class: 'add-block icon-button', disabled: structureDisabled(), title:room?t('roomStopFirst'):t('addBlock') }));
    content.append(node('details',{class:'workspace-editor-help'},[
      node('summary',{},t('editorHelp')),
      node('p',{class:'draft-note'},t(room?'roomDraftHint':'autoSaveHint')),
      node('p',{class:'draft-note'},t(room?'inline.roomDisabled':'inline.hint')),
      ...(!room?[node('p',{class:'draft-note'},t('mention.editorHint'))]:[]),
      ...(!room?[node('p',{class:'draft-note'},t('nesting.keyboardHint')),node('p',{class:'draft-note'},t('blockMove.hint'))]:[])
    ]));
  }
  if (!state.current && !state.fatal && (state.error || state.notice)) content.prepend(node('p', { class: 'message', role: state.error ? 'alert' : 'status' }, t(state.error || state.notice, state.noticeValues)));
  scroll.append(content); mainPanel.append(topbar, scroll); app.append(sidebar, scrim, mainPanel,
    node('p',{id:'block-dnd-instructions',class:'sr-only'},t('blockDnd.instructions')),
    node('p',{id:'block-dnd-status',class:'sr-only',role:'status','aria-live':'polite','aria-atomic':'true'}));
  blockDnd=createBlockDnd({root:app,canStart:blockId=>dndGeneration===blockDndGeneration&&canDragBlock(blockId),getScope:blockDragScope,getBlocks:()=>state.draft?.blocks||[],getBlockIds:dragSelectionIds,allowMultiPageTransfer:true,canDropOnPage:({blockId,blockIds,pageId})=>dndGeneration===blockDndGeneration&&validBlockPageDrop(pageId)&&canTransferSelection(blockId,blockIds),
    onCommit:operation=>dndGeneration===blockDndGeneration&&commitBlockDrag(operation),onCrossPage:({blockId,blockIds,pageId})=>{if(dndGeneration!==blockDndGeneration||!canDragBlock(blockId)||!validBlockPageDrop(pageId)||!canTransferSelection(blockId,blockIds))return false;void openBlockMove(blockId,pageId,blockIds);return true;},
    onActiveChange:(active,blockId)=>{if(dndGeneration!==blockDndGeneration)return;if(active&&blockSelection.mode&&!blockCoveredBySelection(blockId)){blockSelection.ids=new Set([blockId]);blockSelection.anchor=blockId;refreshBlockSelectionUi();}draggedBlockId=active?blockId:null;autosave.refresh();},labels:(key,values)=>t('blockDnd.'+key,values)});
  refreshBlockSelectionUi();updateDirty();
  refreshPageFeedback();
  const mobile = matchMedia('(max-width: 760px)').matches;
  mainPanel.inert = state.navOpen && mobile; sidebar.inert = !state.navOpen && mobile;
  applyLocaleNotice(document,i18n,{additional:fieldI18n?[fieldI18n]:[]});
  requestAnimationFrame(() => {
    for (const input of app.querySelectorAll('textarea')) autoSize(input);
    if (inlineSelection && !modalOpen()) focusInlineEditor([...app.querySelectorAll('.inline-editor')].find(input => input.dataset.blockId === inlineBlockId), { ...inlineSelection, scroll: false });
    if(tableSelection&&!modalOpen())focusTableCell(tableSelection);
  });
  workspaceBrand?.apply({kind:document.documentElement.style.colorScheme,titleSuffix:'',pageTitle:state.current?state.draft.title||t('untitled'):workspaceName});
}
function blockLocation(blockId, blocks=state.draft?.blocks) { return blocks ? indexEditorBlocks(blocks).get(blockId) : null; }
function syncBlockSelection() {
 const scope=blockDragScope();
 if(scope!==blockSelection.scope||!scope||room&&room.client?.protocol!==2||!canEdit()){blockSelection.scope=scope;blockSelection.mode=false;blockSelection.ids.clear();blockSelection.anchor=null;return;}
 const locations=indexEditorBlocks(state.draft?.blocks||[]);
 for(const blockId of blockSelection.ids)if(!canEditNestedBlock(locations.get(blockId)))blockSelection.ids.delete(blockId);
 if(!locations.has(blockSelection.anchor))blockSelection.anchor=null;
}
function selectedBlockRoots() {
 if(!blockSelection.ids.size||!state.draft)return[];
 try{return normalizeEditorBlockSelection(state.draft.blocks,[...blockSelection.ids]);}catch{return[];}
}
function blockCoveredBySelection(blockId) {
 const location=blockLocation(blockId),roots=new Set(selectedBlockRoots());
 return roots.has(blockId)||!!location?.ancestors.some(parent=>roots.has(parent.id));
}
function dragSelectionIds(blockId) {return blockCoveredBySelection(blockId)?selectedBlockRoots():undefined;}
function setBlockSelectionMode(enabled) {
 if(enabled&&structureDisabled())return;blockDnd?.cancel();blockSelection.mode=enabled;
 if(!enabled){blockSelection.ids.clear();blockSelection.anchor=null;}
 refreshBlockSelectionUi();
 if(enabled)app.querySelector('[data-block-select-id]:not(:disabled)')?.focus();
 else app.querySelector('[data-block-selection-toggle]')?.focus();
}
function toggleBlockSelection(blockId,checked,range=false) {
 if(structureDisabled()){refreshBlockSelectionUi();return;}blockDnd?.cancel();
 const locations=indexEditorBlocks(state.draft.blocks),target=locations.get(blockId);if(!canEditNestedBlock(target))return;
 const anchor=locations.get(blockSelection.anchor);
 const chosen=range&&anchor?editorBlockSelectionRange(state.draft.blocks,blockSelection.anchor,blockId):[blockId];
 for(const selected of chosen)if(checked)blockSelection.ids.add(selected);else blockSelection.ids.delete(selected);
 if(!range||!anchor)blockSelection.anchor=blockId;
 refreshBlockSelectionUi();
}
function refreshBlockSelectionUi() {
 const roots=selectedBlockRoots(),count=roots.length,selected=new Set(roots),locations=indexEditorBlocks(state.draft?.blocks||[]);
 app.classList.toggle('block-selection-mode',blockSelection.mode);
 for(const input of app.querySelectorAll('[data-block-select-id]')){input.hidden=!blockSelection.mode;input.checked=blockSelection.ids.has(input.dataset.blockSelectId);input.disabled=structureDisabled()||!canEditNestedBlock(locations.get(input.dataset.blockSelectId));}
 for(const row of app.querySelectorAll('.block-row[data-block-id]')){const location=locations.get(row.dataset.blockId);row.classList.toggle('is-block-selected',blockSelection.mode&&(selected.has(row.dataset.blockId)||!!location?.ancestors.some(parent=>selected.has(parent.id))));}
 const status=app.querySelector('[data-block-selection-count]');if(status)status.textContent=t('blockSelection.count',{count});
 for(const control of app.querySelectorAll('[data-block-selection-active]'))control.hidden=!blockSelection.mode;
 const toggle=app.querySelector('[data-block-selection-toggle]');if(toggle){toggle.textContent=t(blockSelection.mode?'blockSelection.done':'blockSelection.start');toggle.setAttribute('aria-pressed',String(blockSelection.mode));toggle.disabled=structureDisabled();}
 const move=app.querySelector('[data-block-selection-move]');if(move)move.disabled=!count||structureDisabled()||state.conflict||!!bodySaveBlocked;
 const transfer=app.querySelector('[data-block-selection-transfer]');if(transfer)transfer.disabled=!count||structureDisabled()||state.conflict||!!bodySaveBlocked||!canTransferSelection(roots[0],roots);
 const clear=app.querySelector('[data-block-selection-clear]');if(clear)clear.disabled=!blockSelection.ids.size||structureDisabled();
}
function renderBlockSelectionToolbar() {
 const toolbar=node('div',{class:'block-selection-toolbar','aria-label':t('blockSelection.title')});
 const toggle=button('blockSelection.start',()=>setBlockSelectionMode(!blockSelection.mode),{class:'quiet',disabled:structureDisabled()});toggle.setAttribute('data-block-selection-toggle','');
 const count=node('span',{'data-block-selection-count':'','data-block-selection-active':'',role:'status','aria-live':'polite'});
 const move=button('blockSelection.move',openSelectedBlockMove,{disabled:true});move.setAttribute('data-block-selection-move','');move.setAttribute('data-block-selection-active','');
 const transfer=button('moveBlockToPage',()=>void openBlockMove(selectedBlockRoots()[0]),{disabled:true});transfer.setAttribute('data-block-selection-transfer','');transfer.setAttribute('data-block-selection-active','');
 const clear=button('blockSelection.clear',()=>{blockDnd?.cancel();blockSelection.ids.clear();blockSelection.anchor=null;refreshBlockSelectionUi();},{disabled:true});clear.setAttribute('data-block-selection-clear','');clear.setAttribute('data-block-selection-active','');
 toolbar.append(toggle,count,move,transfer,clear,button('columns.addTwo',()=>addColumns(2),{disabled:!!room||structureDisabled()||state.conflict||!!bodySaveBlocked}),button('columns.addThree',()=>addColumns(3),{disabled:!!room||structureDisabled()||state.conflict||!!bodySaveBlocked}),node('span',{'data-block-selection-active':'',class:'block-selection-hint'},t('blockSelection.hint')));return toolbar;
}
function openSelectedBlockMove() {
 if(structureDisabled()||state.conflict||bodySaveBlocked)return;
 const blockIds=selectedBlockRoots();if(!blockIds.length)return;rememberEditorSelection();
 const scope=blockDragScope(),plan=createEditorMultiMovePlanner(state.draft.blocks,blockIds),positions=['before','after','inside'];
 const locations=indexEditorBlocks(state.draft.blocks),targets=[...locations.values()].filter(location=>positions.some(placement=>{try{return plan({targetId:location.block.id,placement}).changed;}catch{return false;}}));
 const label=location=>t('blockMove.targetLabel',{number:location.order+1,text:columnsTargetText(location).slice(0,80)});
 const target=node('select',{'aria-label':t('blockMove.target')},[node('option',{value:''},t('blockMove.end')),...targets.map(location=>node('option',{value:location.block.id,translate:'no'},label(location)))]);
 const position=node('select',{'aria-label':t('blockMove.position')}),status=node('p',{class:'hint',role:'status'});
 const move=button('blockSelection.apply',()=>{
  if(scope!==blockDragScope()||structureDisabled()||state.conflict||bodySaveBlocked)return;
  const operation={blockIds,targetId:target.value||null,placement:target.value?position.value:'end'};
  try{const latest=planEditorBlocksMove(state.draft.blocks,operation);if(!latest.changed){status.textContent=t('blockSelection.noChange');return;}
   const blocks=moveEditorBlocksTo(state.draft.blocks,operation);rememberEditorSelection();modal.close();finishTreeChange({blocks,roomBlockIds:latest.blockIds,focusHandle:latest.blockIds[0]});
  }catch(error){status.textContent=t(nestingError(error));}
 },{primary:true});
 const update=()=>{
  const selected=position.value;position.replaceChildren();
  if(target.value){for(const placement of positions){try{if(plan({targetId:target.value,placement}).changed)position.append(node('option',{value:placement},t('blockMove.'+placement)));}catch{}}}
  else position.append(node('option',{value:'end'},t('blockMove.end')));
  if([...position.options].some(option=>option.value===selected))position.value=selected;
  let allowed=false;try{allowed=plan({targetId:target.value||null,placement:target.value?position.value:'end'}).changed;}catch{}
  position.disabled=!target.value;move.disabled=!allowed;status.textContent=allowed?'':t('blockSelection.noChange');
 };
 target.addEventListener('change',update);position.addEventListener('change',update);update();
 showModal('blockSelection.move',[node('p',{class:'hint'},t('blockSelection.dialogHint',{count:blockIds.length})),node('label',{class:'field'},[t('blockMove.target'),target]),node('label',{class:'field'},[t('blockMove.position'),position]),status,node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),move])]);target.focus();
}
function renderBodyEntry({parentId=null}={}) {
 const scope=blockDragScope(),generation=blockDndGeneration,host=node('div',{class:'body-entry'}),compositionKey='body-entry:'+(parentId||'root');
 let pending=false;
 const current=()=>scope===blockDragScope()&&generation===blockDndGeneration&&host.isConnected&&!structureDisabled()&&!modalOpen();
 const materialize=(text,metadata={},selection={start:text.length},split=false)=>{
  if(pending||!current()||!split&&!text)return;pending=true;
  queueMicrotask(()=>{
   pending=false;if(!current())return;
   try{
    const block={id:crypto.randomUUID(),type:'paragraph',data:editableBlockData({},text,metadata.marks||[],metadata.links||[],metadata.mentions||[])};
    rememberEditorSelection();let blocks=insertEditorBlock(state.draft.blocks,{block,parentId,index:parentId===null?state.draft.blocks.length:blockLocation(parentId).block.children.length});
    if(split){const result=splitEditorBlock(blocks,{blockId:block.id,start:selection.start,end:selection.end??selection.start,newId:crypto.randomUUID()});finishTreeChange(result);}
    else finishTreeChange({blocks,focus:{blockId:block.id,...selection}});
   }catch(error){state.error=nestingError(error);refreshPageFeedback();}
  });
 };
 const previous=()=>{
  const target=[...indexEditorBlocks(state.draft.blocks).values()].reverse().find(location=>(parentId===null||location.ancestors.some(parent=>parent.id===parentId))&&canEditNestedBlock(location)&&typeof location.block.data?.text==='string'&&location.block.type!=='divider');
  if(target)focusBlock(target.block.id,target.block.data.text.length);else focusContent();return true;
 };
 const input=createInlineEditor({text:'',className:'block-input body-entry-input',label:t('bodyEntry.label'),placeholder:t(state.draft.blocks.length?'bodyEntry.continue':'placeholder'),
  onChange:(text,metadata)=>{const selection=captureInlineSelection(input)||{start:text.length};queueMicrotask(()=>materialize(text,metadata,selection));},
  onSplit:room?undefined:selection=>materialize('',{},selection,true),onSlash:room?undefined:()=>openBlockPicker(null,{parentId,index:parentId===null?state.draft.blocks.length:blockLocation(parentId).block.children.length}),onHistory:applyEditorHistory,
  onMerge:previous,onNavigate:direction=>direction<0?previous():false,onBeforeFormat:rememberEditorSelection,onFormatError:()=>{state.error='inline.error';refreshPageFeedback();},onLimit:()=>{state.error='textTooLong';refreshPageFeedback();}});
 input.dataset.bodyEntry='';
 host.append(createPageMentionPicker(input));
 input.addEventListener('compositionstart',()=>{roomCompositions.add(compositionKey);autosave.refresh();});
 input.addEventListener('compositionend',()=>{roomCompositions.delete(compositionKey);autosave.refresh();});
 host.append(input);return host;
}
function wideBlockSelection() {
 const selection=document.getSelection();if(!selection?.rangeCount || selection.isCollapsed)return false;
 const range=selection.getRangeAt(0),selected=[...app.querySelectorAll('.inline-editor')].filter(input=>range.intersectsNode(input));
 return selected.length>1 || selected.length===1 && (!selected[0].contains(range.startContainer)||!selected[0].contains(range.endContainer));
}
function nestingError(error) {
 if(error?.code==='ROOM_CAPACITY')return 'roomCapacity';if(error?.code==='ROOM_TOO_LARGE')return 'tooLarge';if(error?.message==='ROOM_OPERATION_UNSUPPORTED')return 'roomStopFirst';if(error?.code==='ROOM_OPERATION_CONFLICT')return 'roomOperationConflict';
 return ({BLOCK_NESTING_LIMIT:'nesting.limit',BLOCK_NO_PREVIOUS_SIBLING:'nesting.noPrevious',BLOCK_ALREADY_AT_ROOT:'nesting.atRoot',BLOCK_PARENT_UNSUPPORTED:'nesting.unsupportedParent',BLOCK_NESTING_READ_ONLY:'nesting.readOnly',BLOCK_CHILDREN_JOIN_UNSUPPORTED:'nesting.mergeChildren',BLOCK_MERGE_UNSUPPORTED:'nesting.mergeUnsupported',BLOCK_HAS_CHILDREN:'nesting.hasChildren',BLOCK_MOVE_CYCLE:'blockMove.cycle',BLOCK_MOVE_SELF:'blockMove.self',BLOCK_MOVE_SELECTION:'blockSelection.destination',INVALID_BLOCK_SELECTION:'blockSelection.invalid',BLOCK_COLUMNS_NESTED:'columns.nested',BLOCK_COLUMNS_STRUCTURE:'columns.invalid',EDITOR_HISTORY_UNAVAILABLE:'historyUnavailable',EDITOR_HISTORY_TOO_LARGE:'historyUnavailable'})[error?.message] || 'nesting.failed';
}
function structureAllowed(blockId) {
 if(structureDisabled())return false;
 if(wideBlockSelection()){state.error='nesting.singleBlock';render();return false;}
 if(blockId && !canEditNestedBlock(blockLocation(blockId))&&!canEditEditorParent(blockLocation(blockId))){state.error='nesting.readOnly';render();return false;}
 return true;
}
function finishRoomTransform(prepared) {
 if(!prepared)return false;const active=room;if(!active||!active.client.supportsFeature('block-transforms')||structureDisabled()||state.conflict||bodySaveBlocked)throw new TypeError('ROOM_OPERATION_UNSUPPORTED');
 const draft=active.client.operation(prepared.operation);state.draft=clone(draft);presence.changed();updateDirty();render();const focus=prepared.focus;if(focus?.blockId&&blockLocation(focus.blockId))focusBlock(focus.blockId,focus.start||0,focus.end??focus.start??0);else focusContent();return true;
}
function finishTreeChange(result,selection) {
 if(room){if(structureDisabled())throw new TypeError('ROOM_OPERATION_UNSUPPORTED');const prepared=prepareRoomTreeOperation(state.draft.blocks,result.blocks,{blockIds:result.roomBlockIds});let draft;try{draft=room.client.operation(prepared.operation,prepared);}catch(error){if(['ROOM_CAPACITY','ROOM_TOO_LARGE'].includes(error?.code))stopRoomInput(room);throw error;}state.draft=clone(draft);presence.changed();}
 else state.draft.blocks=result.blocks;updateDirty();render();
 if(result.focusHandle){requestAnimationFrame(()=>[...app.querySelectorAll('[data-block-drag-handle]')].find(handle=>handle.closest('[data-block-id]')?.dataset.blockId===result.focusHandle)?.focus({preventScroll:true}));return;}
 const focus=result.focus || selection;if(focus?.blockId)focusBlock(focus.blockId,focus.start||0,focus.end??focus.start??0);else focusContent();
}
function nestingAvailability(blockId,direction,planner=(id,direction)=>planEditorNesting(state.draft.blocks,id,direction)) {try{planner(blockId,direction);return {enabled:true};}catch(error){return{enabled:false,reason:nestingError(error)};}}
function changeBlockNesting(blockId,direction,selection,{keyboard=false}={}) {
 if(!structureAllowed(blockId))return true;
 const available=nestingAvailability(blockId,direction);
 if(!available.enabled){if(keyboard && ['nesting.noPrevious','nesting.atRoot'].includes(available.reason))return false;state.error=available.reason;render();return true;}
 rememberEditorSelection();
 try{finishTreeChange({blocks:nestEditorBlock(state.draft.blocks,blockId,direction),roomBlockIds:[blockId]},selection || {blockId,start:0});}
 catch(error){state.error=nestingError(error);render();}return true;
}
function renderBlock(block,locations,nestingPlanner) {
 const location=locations.get(block.id),depth=location.depth,number=location.order+1;
 if(block.type==='columns'&&canEditNestedBlock(location,{ignoreDepth:true}))return renderColumns(block,location,locations,nestingPlanner);
 const branch=node('div',{class:'block-branch'+(depth>=MAX_EDITOR_NESTING?' legacy-deep-block':'')});branch.dataset.branchId=block.id;branch.dataset.dndBlockId=block.id;
 branch.append(renderBlockRow(block,location,locations,nestingPlanner));
 if(block.children?.length)branch.append(node('div',{class:'nested-block-list'+(depth>=MAX_EDITOR_NESTING-1?' depth-capped':''),role:'group','aria-label':t('nesting.children',{number})},block.children.map(child=>renderBlock(child,locations,nestingPlanner))));
 return branch;
}
function columnsTargetText(location) {
 if(location.block.type==='columns')return t('columns.group',{count:location.block.children?.length||0});
 if(location.block.type==='column')return t('columns.column',{number:location.index+1});
 return location.block.data?.purpose==='import-source'?t('importSource'):location.block.data?.text||t(supportedTypes.includes(location.block.type)?location.block.type:'unsupported');
}
function columnsAt(parentId) {
 const parent=parentId?blockLocation(parentId):null;
 return !parent||![parent.block,...parent.ancestors].some(block=>['columns','column'].includes(block.type));
}
function addColumns(count,blockId=null,target={parentId:null,index:state.draft.blocks.length}) {
 if(room)return;
 if(!structureAllowed(blockId||target.parentId)||state.conflict||bodySaveBlocked)return;
 try{
  const result=blockId?wrapEditorBlockInColumns(state.draft.blocks,{blockId,count}):insertEditorColumns(state.draft.blocks,{count,...target});
  rememberEditorSelection();if(modal.open)modal.close();finishTreeChange({blocks:result.blocks,focus:{blockId:result.focusId,start:0}});
 }catch(error){state.error=nestingError(error);refreshPageFeedback();}
}
function removeColumns(groupId) {
 if(room)return;
 if(!structureAllowed(groupId)||state.conflict||bodySaveBlocked)return;
 try{const result=unwrapEditorColumns(state.draft.blocks,groupId);rememberEditorSelection();if(modal.open)modal.close();finishTreeChange({blocks:result.blocks,...(result.focusId?{focus:{blockId:result.focusId,start:0}}:{})});}
 catch(error){state.error=nestingError(error);refreshPageFeedback();}
}
function openColumnsActions(groupId) {
 if(!structureAllowed(groupId)||state.conflict||bodySaveBlocked)return;
 const count=blockLocation(groupId)?.block.children?.length;
 showModal('columns.actions',[node('p',{class:'hint'},t('columns.unwrapHint')),node('div',{class:'block-action-list'},[
  button('blockMove.inPage',()=>openInPageBlockMove(groupId)),
  button('columns.resizeTwo',()=>openColumnsResize(groupId,2),{disabled:!!room||count===2}),button('columns.resizeThree',()=>openColumnsResize(groupId,3),{disabled:!!room||count===3}),
  button('columns.unwrap',()=>removeColumns(groupId),{disabled:!!room}),button('deleteBlock',()=>deleteNestedBlock(groupId))
 ])]);
}
function openColumnsResize(groupId,count) {
 if(room)return;
 if(!structureAllowed(groupId)||state.conflict||bodySaveBlocked)return;
 let review;try{review=createColumnResizeReview({draft:state.draft,scope:blockDragScope(),generation:draftGeneration,groupId,count,history:editorHistory});}catch(error){state.error=nestingError(error);refreshPageFeedback();return;}
 const plan=review.plan;
 if(!plan.changed)return;
 const token={},status=node('p',{class:'hint',role:'status'});
 const current=()=>({scope:blockDragScope(),draft:state.draft,generation:draftGeneration,history:editorHistory,enabled:modal.open&&modal.dataset.view==='columns.resizeTitle'&&modal.columnResizeToken===token&&!structureDisabled()&&!state.conflict&&!bodySaveBlocked});
 const cancel=button('cancel',()=>{review.cancel();if(modal.columnResizeToken===token)modal.close();});
 const confirm=button('columns.resizeConfirm',()=>{
  if(!editorHistory){status.textContent=t('historyUnavailable');confirm.disabled=true;return;}
  if(!review.current(current())||!structureAllowed(groupId)){status.textContent=t('columns.resizeChanged');confirm.disabled=true;return;}
  try{
   const result=review.apply(current());if(!result.changed)return;
   confirm.disabled=true;rememberEditorSelection();finishTreeChange({blocks:result.blocks,...(result.focusId?{focus:{blockId:result.focusId,start:0}}:{focusHandle:groupId})});modal.close();
  }catch(error){status.textContent=t(nestingError(error));if(['EDITOR_HISTORY_UNAVAILABLE','EDITOR_HISTORY_TOO_LARGE'].includes(error?.message))confirm.disabled=true;}
 },{primary:true});
 const preview=plan.movedRootIds.map(id=>{const location=blockLocation(id);return node('li',{translate:'no'},columnsTargetText(location).slice(0,160));});
 showModal('columns.resizeTitle',[
  node('p',{},t('columns.resizeSummary',{from:plan.fromCount,to:plan.toCount})),
  node('p',{class:'hint'},t(plan.toCount<plan.fromCount?'columns.resizeMergeHint':'columns.resizeAddHint')),
  ...(plan.toCount<plan.fromCount?[node('p',{},t('columns.resizeMoveCount',{roots:plan.movedRootIds.length,blocks:plan.movedBlockCount})),preview.length?node('ul',{},preview):node('p',{class:'hint'},t('columns.resizeEmpty'))]:[]),
  node('p',{class:'hint'},t('columns.resizeUndo')),status,node('div',{class:'dialog-actions'},[cancel,confirm])
 ]);modal.columnResizeToken=token;cancel.focus();
}
function renderColumns(block,location,locations,nestingPlanner) {
 const mutable=canEditNestedBlock(location),disabled=structureDisabled()||!mutable||state.conflict||!!bodySaveBlocked;
 const branch=node('section',{class:'block-branch block-columns-group','data-branch-id':block.id,'data-dnd-block-id':block.id,'aria-label':t('columns.group',{count:block.children.length})});
 const row=node('div',{class:'block-row block-columns','data-block-id':block.id});
 const grip=button('columns.actions',()=>openColumnsActions(block.id),{icon:'grip',iconOnly:true,label:t('columns.actions'),class:'block-handle icon-button',disabled});
 grip.setAttribute('data-block-drag-handle','');grip.setAttribute('aria-describedby','block-dnd-instructions');grip.title=t('blockDnd.handle');
 const select=node('input',{type:'checkbox',class:'block-select',hidden:!blockSelection.mode,'data-block-select-id':block.id,'aria-label':t('blockSelection.select',{number:location.order+1}),checked:blockSelection.ids.has(block.id),disabled,onClick:event=>toggleBlockSelection(block.id,event.currentTarget.checked,event.shiftKey)});
 row.append(node('div',{class:'inline-actions'},[select,grip]),node('span',{class:'columns-label'},t('columns.group',{count:block.children.length})),button('columns.unwrap',()=>removeColumns(block.id),{class:'quiet',disabled:disabled||!!room}));
 const grid=node('div',{class:'columns-grid','data-column-count':block.children.length,role:'group','aria-label':t('columns.group',{count:block.children.length})});
 for(const column of block.children){
  const columnLocation=locations.get(column.id),columnMutable=canEditEditorParent(columnLocation),label=t('columns.column',{number:columnLocation.index+1});
  const cell=node('div',{class:'column-cell','data-column-id':column.id,role:'group','aria-label':label});
  const target=node('div',{class:'block-row block-column'+(column.children.length?'':' is-empty-column'),'data-block-id':column.id,tabindex:'-1','aria-label':label},[
   node('span',{},label),button('columns.addBlock',()=>openBlockPicker(null,{parentId:column.id,index:column.children.length}),{icon:'plus',iconOnly:true,label:t('columns.addBlock'),class:'quiet icon-button',disabled:structureDisabled()||!columnMutable})
  ]);
  const body=node('div',{class:'column-blocks'},column.children.map(child=>renderBlock(child,locations,nestingPlanner)));
  const last=column.children.at(-1);
  if(!structureDisabled()&&columnMutable&&!(last?.type==='paragraph'&&last.data?.text===''&&!last.children?.length))body.append(renderBodyEntry({parentId:column.id}));
  cell.append(target,body);grid.append(cell);
 }
 branch.append(row,grid);return branch;
}
function renderBlockRow(block,location,locations,nestingPlanner) {
 const type=block.type,index=location.index,number=location.order+1,mutable=canEditNestedBlock(location)&&(!room||type!=='table');
 const sourceText=importSourceText(block);
 if(sourceText!==null){
  const code=node('pre',{class:'unsupported-block',tabindex:'0',translate:'no'},node('code',{},sourceText));
  const part=Number.isSafeInteger(block.data.sourcePart)&&Number.isSafeInteger(block.data.sourceParts)&&block.data.sourcePart>0&&block.data.sourceParts>=block.data.sourcePart?t('importSourcePart',{part:block.data.sourcePart,total:block.data.sourceParts}):t('importSource');
  return node('details',{class:'import-source-reference'},[node('summary',{},part),code]);
 }
 const simpleTable=type==='table'&&isSimpleTableData(block.data),supported=supportedTypes.includes(type),row=node('div',{class:'block-row block-'+(supported||simpleTable?type:'unsupported')+(type==='heading'?' level-'+Math.max(1,Math.min(3,block.data?.level||1)):'' )});
 row.dataset.blockId=block.id;
 row.append(node('div',{class:'inline-actions'},[
  button('insertBlockHere',()=>openBlockPicker(null,{parentId:location.parentId,index}),{icon:'plus',iconOnly:true,label:t('insertBlockHere'),class:'block-handle inline-add icon-button',disabled:structureDisabled()||!mutable}),
  button('blockActions',()=>openBlockActions(block.id),{icon:'grip',iconOnly:true,label:t('blockActions',{number}),class:'block-handle icon-button',disabled:structureDisabled()||!mutable})
 ]));
 const grip=row.querySelector('.inline-actions button:last-child');
 grip.setAttribute('data-block-drag-handle','');grip.setAttribute('aria-describedby','block-dnd-instructions');
 grip.title=t('blockDnd.handle');
 const select=node('input',{type:'checkbox',class:'block-select',hidden:!blockSelection.mode,'data-block-select-id':block.id,'aria-label':t('blockSelection.select',{number}),checked:blockSelection.ids.has(block.id),disabled:structureDisabled()||!mutable,onClick:event=>toggleBlockSelection(block.id,event.currentTarget.checked,event.shiftKey)});
 row.querySelector('.inline-actions').prepend(select);
 if(simpleTable){
  const scope=blockDragScope(),enabled=()=>scope===blockDragScope()&&row.isConnected&&!room&&!editingDisabled()&&!state.conflict&&!bodySaveBlocked&&!modalOpen()&&!draggedBlockId&&canEditNestedBlock(blockLocation(block.id));
  const view=createTableBlockView({document,data:block.data,blockId:block.id,pageId:state.current.page.id,getData:()=>blockLocation(block.id)?.block.data,readOnly:!!room||!mutable,canEdit:enabled,labels:(key,values)=>t('simpleTable.'+key,values),onBeforeChange:rememberEditorSelection,
   onChange:(data,change)=>{if(!enabled())return;blockLocation(block.id).block.data=data;updateDirty(change.kind==='text'?'table-cell-'+block.id+'-'+change.row+'-'+change.column:null);},
   onComposition:(active,key)=>{const marker='table:'+block.id+':'+key;if(active)roomCompositions.add(marker);else roomCompositions.delete(marker);autosave.refresh();},onHistory:applyEditorHistory,
   onError:error=>{state.error=error.message==='SIMPLE_TABLE_TOO_LARGE'?'simpleTable.limit':'simpleTable.error';refreshPageFeedback();},confirmDelete:({axis,index})=>window.confirm(t(axis==='row'?'simpleTable.confirmDeleteRow':'simpleTable.confirmDeleteColumn',{number:index+1}))});
  row.append(view.element);if(room)row.append(node('p',{class:'block-note'},t('simpleTable.roomReadOnly')));return row;
 }
 if(type==='divider'){row.append(node('hr',{class:'block-divider'}));return row;}
 if(['bulleted-list','numbered-list'].includes(type))row.append(node('span',{class:'block-marker','aria-hidden':'true'},type==='bulleted-list'?'•':String(Number.isSafeInteger(block.data?.start)?block.data.start:1)+'.'));
 if(supported&&type==='checklist'){
  const scope=blockDragScope(),check=node('input',{type:'checkbox',class:'block-check','data-block-check-id':block.id,checked:block.data?.checked===true,disabled:structureDisabled()||!mutable||!!room&&!room.client?.supportsFeature?.('check-state'),'aria-label':t('checked',{number})});
  check.addEventListener('change',()=>{
   const active=room,location=blockLocation(block.id),restore=()=>{check.checked=block.data?.checked===true;};
   if(scope!==blockDragScope()||!row.isConnected||location?.block!==block||structureDisabled()||modalOpen()||!canEditNestedBlock(location)||active&&!active.client?.supportsFeature?.('check-state')){restore();return;}
   try{
    const command=prepareRoomCheckOperation(state.draft.blocks,{blockId:block.id,checked:check.checked});if(!command)return;
    if(active)active.client.setChecked(command);
    block.data={...block.data,checked:command.checked};if(active)presence.changed();updateDirty();
   }catch(error){restore();state.error=nestingError(error);if(active)stopRoomInput(active);else refreshPageFeedback();}
  });row.append(check);
 }
 const text=typeof block.data?.text==='string'?block.data.text:'';
 if(supported&&text.length>MAX_INLINE_TEXT){row.append(node('div',{class:'unsupported-block'},[node('p',{},t('textTooLong')),node('pre',{translate:'no'},text)]));return row;}
 if(supported){
  const transformScope=blockDragScope(),transformCurrent=()=>transformScope===blockDragScope()&&row.isConnected&&blockLocation(block.id)?.block===block&&!modalOpen()&&!state.conflict&&!bodySaveBlocked;
  const input=createInlineEditor({text,marks:block.data?.marks||[],links:readableLinks(block.data),mentions:block.data?.mentions||[],pageHref:pageReferenceHref,preserveInsertedFormatting:!room||room.client?.protocol===2,formatEnabled:(!room||room.client?.protocol===2)&&type!=='code',className:'block-input',readOnly:editingDisabled()||!mutable||!!room&&typeof block.data?.text!=='string',
   placeholder:t(type==='paragraph'?'placeholder':type),label:t('blockText',{number}),
   onChange:(value,change)=>{block.data=editableBlockData(block.data,value,change.marks,change.links,change.mentions);if(change.kind==='text')recordRoomText('block:'+block.id,value,change);else if(room&&change.kind==='format'){try{room.client.setMarks({blockId:block.id,...change.range,marks:change.marks});presence.changed();}catch{stopRoomInput(room);}}updateDirty(['format','reference','mention'].includes(change.kind)?null:'text-'+block.id);refreshBlockLinks(row,block);},
   onBeforeFormat:rememberEditorSelection,onFormatError:()=>{state.error='inline.error';render();},onLimit:()=>{state.error='textTooLong';render();},
   onSlash:type==='code'||room?undefined:()=>openBlockPicker(block.id),onHistory:direction=>applyEditorHistory(direction),
   onIndent:type==='code'?undefined:(direction,selection)=>changeBlockNesting(block.id,direction,{blockId:block.id,...selection},{keyboard:true}),
   onStructureError:()=>{state.error='nesting.singleBlock';render();},
   onShortcut:prefix=>{if(room||!structureAllowed(block.id)||block.type!=='paragraph'||block.children?.length)return false;const conversion=markdownPrefix(prefix);if(!conversion)return false;rememberEditorSelection();block.data=editableBlockData(block.data,prefix);updateDirty('text-'+block.id);block.type=conversion.type;block.data=conversion.data;let focusId=block.id;if(block.type==='divider'){const next={id:crypto.randomUUID(),type:'paragraph',data:{text:''}};const current=blockLocation(block.id);state.draft.blocks=insertEditorBlock(state.draft.blocks,{block:next,parentId:current.parentId,index:current.index+1});focusId=next.id;}updateDirty();render();focusBlock(focusId);return true;},
   onSplit:type==='code'||room&&!room.client?.supportsFeature('block-transforms')?undefined:selection=>{if(!transformCurrent()||!structureAllowed(block.id))return;rememberEditorSelection();try{if(room){finishRoomTransform(prepareRoomSplitOperation(state.draft.blocks,{blockId:block.id,start:selection.start,end:selection.end,newBlockId:crypto.randomUUID()}));return;}finishTreeChange(splitEditorBlock(state.draft.blocks,{blockId:block.id,start:selection.start,end:selection.end,newId:crypto.randomUUID()}));}catch(error){state.error=nestingError(error);render();}},
   onMerge:type==='code'||room&&!room.client?.supportsFeature('block-transforms')?undefined:()=>{if(!transformCurrent()||!structureAllowed(block.id))return true;rememberEditorSelection();try{if(room)return finishRoomTransform(prepareRoomMergeOperation(state.draft.blocks,block.id));const result=mergeEditorBlock(state.draft.blocks,block.id);if(!result.changed)return false;finishTreeChange(result);return true;}catch(error){state.error=nestingError(error);render();return true;}},
   onNavigate:direction=>{const eligible=[...locations.values()].filter(value=>canEditNestedBlock(value)&&!['divider'].includes(value.block.type)&&value.block.data?.purpose!=='import-source'),position=eligible.findIndex(value=>value.block.id===block.id),target=eligible[position+direction]?.block;if(!target)return false;focusBlock(target.id,direction<0?(target.data?.text||'').length:0);return true;}
  });
  input.dataset.blockId=block.id;input.dataset.pageId=state.current.page.id;
  input.addEventListener('beforeinput',rememberEditorSelection);input.addEventListener('compositionstart',()=>{roomCompositions.add(block.id);updateDirty();});input.addEventListener('compositionend',()=>{roomCompositions.delete(block.id);updateDirty();});
  const surface=node('div',{class:'inline-edit-surface'},input),formatToolbar=createInlineToolbar(input,{labels:inlineFormattingLabels(t),...(!room&&type!=='code'?{pageReferences:{load:loadPageReferenceCandidates,href:pageReferenceHref}}:{})});if(formatToolbar)surface.append(formatToolbar);if(!room&&type!=='code'&&mutable&&!editingDisabled())surface.append(createPageMentionPicker(input));
  row.append(surface);refreshBlockLinks(row,block);
  if(!mutable)row.append(node('p',{class:'block-note'},t(location.depth>=MAX_EDITOR_NESTING?'nesting.legacyDepth':'nesting.readOnly')));
 }else row.append(node('div',{class:'unsupported-block'},[node('p',{},t('unsupported')),...(text?[node('p',{translate:'no'},text)]:[])]));
 return row;
}
function attachmentPath(attachmentId) { return basePath()+'/'+encodeURIComponent(state.current.page.id)+'/attachments/'+encodeURIComponent(attachmentId); }
function renderPageAttachments() {
  const list=node('ul',{class:'page-attachments'});
  for(const attachment of state.current.attachments) {
    if(!validId(attachment.id) || typeof attachment.name!=='string' || !Number.isSafeInteger(attachment.size) || attachment.size<0) continue;
    list.append(node('li',{},[node('a',{href:attachmentPath(attachment.id),download:attachment.name,translate:'no'},attachment.name),node('small',{},new Intl.NumberFormat(i18n.locale).format(attachment.size)+' B')]));
  }
  return node('section',{class:'attachments-section','aria-label':t('attachments')},[node('h2',{},t('attachments')),list,node('p',{class:'hint'},t('attachmentsHint'))]);
}
function collectionPath(collectionId = state.current?.page.collectionId) {
  return '/api/content/workspaces/' + encodeURIComponent(workspaceId) + '/collections/' + encodeURIComponent(collectionId);
}
function pageReferenceHref(link){return '/workspace.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(link.pageId)+(link.fragment?'#'+encodeURIComponent(link.fragment.toWellFormed()):'');}
function createPageMentionPicker(input){
 const scope=JSON.stringify([state.user?.id,workspaceId,state.current?.page.id,state.selection]);
 return createMentionPicker(input,{getContext:()=>!room&&!editingDisabled()&&JSON.stringify([state.user?.id,workspaceId,state.current?.page.id,state.selection])===scope?scope:null,
  labels:Object.fromEntries(['label','loading','empty','error','person','page','date','today','tomorrow','hint','chooseDate','insertDate'].map(name=>[name,t('mention.'+name)])),
  load:async()=>{
   const pageId=state.current?.page.id,actorId=state.user?.id;
   const values=await Promise.allSettled([loadPageReferenceCandidates(),request(basePath()+'/'+encodeURIComponent(pageId)+'/people',{headers:{'X-Yumunio-Expected-Account':actorId}})]);
   for(const value of values)if(value.status==='rejected')throw value.reason;
   if(scope!==JSON.stringify([state.user?.id,workspaceId,state.current?.page.id,state.selection]))throw new Error('ACCOUNT_CHANGED');
   const [pages,people]=values.map(value=>value.value);
   if(people?.pageId!==pageId||!Array.isArray(people.people)||people.people.length>1000||people.people.some(person=>!validId(person.accountId)||typeof person.name!=='string'))throw new Error('INVALID_RESPONSE');
   return [...people.people.map(person=>({kind:'person',accountId:person.accountId,label:person.name.slice(0,240)})),...pages.map(page=>({kind:'page',pageId:page.id,label:page.title||t('untitled')}))];
  }});
}
async function loadPageReferenceCandidates(){
 const selected=state.selection,pageId=state.current?.page.id,actorId=state.user?.id;const value=await request(basePath(),{headers:{'X-Yumunio-Expected-Account':actorId}});
 if(selected!==state.selection||pageId!==state.current?.page.id||actorId!==state.user?.id||!Array.isArray(value?.pages))throw new Error('ACCOUNT_CHANGED');
 return value.pages.filter(page=>validId(page.id)&&typeof page.title==='string'&&page.trashedAt===null&&page.capabilities?.includes('read')).map(page=>({id:page.id,title:page.title||t('untitled')}));
}
function refreshBlockLinks(row,block) {
  row.querySelector('.block-links')?.remove();
  const original = state.current ? blockLocation(block.id,state.current.document.blocks)?.block : null;
  const links = readableLinks(block.data);
  const changed = original?.data?.links?.length && !links.length && original.data.text !== block.data?.text;
  if (!links.length && !changed) return;
  const preview = node('div',{class:'block-links'});
  if (changed) preview.append(node('p',{class:'hint'},t('linksEdited')));
  else {
    preview.append(node('span',{class:'link-preview-label'},t('pageLinks')));
    for (const link of links) {
      if (link.unavailable) preview.append(node('span',{class:'link-unavailable',title:t('linkUnavailable'),translate:'no'},link.label));
      else if (link.attachmentId) {
        const attachment=state.current.attachments?.find(item=>item.id===link.attachmentId);
        preview.append(attachment && link.pageId===state.current.page.id ? node('a',{href:attachmentPath(attachment.id),download:attachment.name,translate:'no'},link.label) : node('span',{class:'link-unavailable',title:t('linkUnavailable'),translate:'no'},link.label));
      } else preview.append(node('a',{href:'/workspace.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(link.pageId)+(link.fragment?'#'+encodeURIComponent(link.fragment.toWellFormed()):''),translate:'no'},link.label));
    }
  }
  row.append(preview);
}
function recordName(record,index) { return state.pages.find(page=>page.id===record.pageId)?.title || t('recordNumber',{number:index+1}); }
function openSourceCells(record) {
  const properties=record.sourceKind==='manual'?[]:state.collection.collection.sourceProperties??state.collection.collection.properties;
  showModal('originalCells', [node('p',{class:'hint'},t(properties.length?'originalCellsHint':'noOriginalCells')),
    ...(properties.length?[node('dl',{class:'source-cell-list'},properties.flatMap(property=>[
      node('dt',{translate:'no'},property.name),node('dd',{translate:'no'},record.sourceValues[property.id] || t('emptyCell'))
    ]))]:[])]);
}
function recordEditor(record,index,{table=false,readOnly=false}={}) {
  const model=state.collection, disabled=readOnly || !!room || state.busy || collectionActivities.size>0 || state.loading || state.locked || state.conflict || !model.canEdit(record.id);
  const hasDraft=()=>model.dirtyPropertyIds(record.id).length>0;
  const save=button('saveValues',()=>void saveRecord(record.id),{primary:true,disabled:disabled || !hasDraft(),class:'record-save'});
  const status=node('span',{class:'record-status',role:'status'},hasDraft()?t('dirty'):'');
  const inputs=model.collection.properties.map(property=> {
    const immutable=['formula','rollup'].includes(property.type) || record.redactedProperties?.includes(property.id);
    let input;
    if(immutable)input=renderRecordCollectionValue({record,property,document,people:state.people,pages:state.pages,t:fieldT});
    else {
      input=createCollectionValueInput({document,property,value:model.rawValue(record.id,property.id),people:state.people,pages:state.pages,t:fieldT,disabled:disabled || !model.canEdit(record.id,property.id)});
      input.setAttribute('aria-label',t('cellValue',{column:property.name,row:recordName(record,index)}));input.setAttribute('translate','no');
      if(input.disabled && ['INPUT','TEXTAREA'].includes(input.tagName)){input.disabled=false;input.readOnly=true;}
      input.addEventListener('input',()=> {
        if(disabled || state.busy || collectionActivities.size>0 || !model.canEdit(record.id,property.id))return;
        try {model.setRaw(record.id,property.id,input.rawValue());}catch{state.recordError='recordInvalidValue';return;}
        updateDirty();save.disabled=disabled || !hasDraft();status.textContent=hasDraft()?t('dirty'):'';
      });
    }
    const hint=collectionFieldHint(property,{record,t:fieldT}),content=node('div',{class:'record-field-content'},[input,...(hint?[node('small',{class:'hint'},hint)]:[])]);
    return table ? node('td',{},content) : node('label',{class:'field record-property'},[node('span',{translate:'no'},property.name),content]);
  });
  const actions=node('div',{class:'record-actions'},[save,button('originalCells',()=>openSourceCells(record)),status]);
  if (!table) return node('div',{class:'record-properties'},[...inputs,actions]);
  return node('tr',{},[node('th',{scope:'row'},node('button',{type:'button',class:'record-page-link',onClick:()=>void selectPage(record.pageId),disabled:state.busy,translate:'no'},recordName(record,index))),...inputs,node('td',{},actions)]);
}
function renderCollection() {
  const model=state.collection, recordId=state.current.page.recordId;
  const section=node('section',{class:'collection-editor','aria-label':t(recordId?'recordProperties':'collectionTable')});
  section.append(node('div',{class:'collection-heading'},[node('h2',{},t(recordId?'recordProperties':'collectionTable')),node('span',{class:'hint'},t('typedColumns'))]));
  if (state.recordError && !(model.conflict && state.recordError === 'recordConflict')) section.append(node('p',{class:'message',role:'alert'},['assigneeNotificationLimit','embeddedPropertiesChanged'].includes(state.recordError)?fieldT(state.recordError):t(state.recordError)));
  if (model.conflict) section.append(node('p',{class:'hint'},t('recordConflict')));
  if (recordId) {
    const record=model.record(recordId);
    section.append(record?recordEditor(record,0):node('p',{class:'hint'},t('recordUnavailable'))); return section;
  }
  const views=node('div',{class:'workspace-collection-views'});section.append(views);
  const scope=collectionScope();
  queueMicrotask(()=>{if(views.isConnected&&scope===collectionScope()&&state.collection===model)mountCollectionViews(views,scope);});
  section.append(node('p',{class:'hint'},t('tableSaveHint')));
  return section;
}
function collectionScope(){return state.current&&state.user?JSON.stringify([state.user.id,workspaceId,state.current.page.id,state.selection]):null;}
async function collectionActor(actorId,signal){const session=await request('/api/auth/get-session',{signal});if(session?.user?.id!==actorId||session.user.emailVerified!==true)throw new ApiError(401,'ACCOUNT_CHANGED');}
function mountCollectionViews(root,scope){
 const actorId=state.user.id,pageId=state.current.page.id,collectionId=state.collection.collection.id,token={},pendingPages=new WeakMap();let ownsWrite=false;
 const current=()=>collectionScope()===scope&&state.current?.page.id===pageId&&state.collection?.collection.id===collectionId;
 const canRead=()=>current()&&!state.locked&&!state.loading&&(!state.busy||ownsWrite)&&!modalOpen();
 const canWrite=()=>canRead()&&!room&&!state.conflict&&!bodySaveBlocked&&!state.collection.conflict&&!roomCompositions.size;
 const release=(busy,kind)=>{if(busy){collectionActivities.add(token);if(kind==='write'){ownsWrite=true;state.busy=true;}}else{collectionActivities.delete(token);if(ownsWrite){ownsWrite=false;state.busy=false;}}autosave.refresh();refreshSaveStatus();};
 const readView=async(viewId,{signal})=>{
  const activeRoom=room,baseline=state.current;await collectionActor(actorId,signal);
  const [value,page]=await Promise.all([request(collectionPath(collectionId)+(viewId?'/views/'+encodeURIComponent(viewId):''),{signal}),request(basePath()+'/'+encodeURIComponent(pageId),{signal})]);
  await collectionActor(actorId,signal);if(!current()||room!==activeRoom)throw new ApiError(409,'COLLECTION_READ_CHANGED');
  const fresh=validatePageEnvelope(page,pageId),next=validateWorkspaceCollectionRead(value,fresh,{workspaceId,collectionId,pageId,baseline,inRoom:!!activeRoom,expectedViewId:viewId});
  pendingPages.set(next,{fresh,activeRoom});
  return next;
 };
 if(collectionViewId&&!state.collection.collection.views.some(view=>view.id===collectionViewId))collectionViewId=null;
 const controller=mountWorkspaceCollectionView({root,getModel:()=>state.collection,isCurrent:current,canRead,canWrite,readView,
  selectedViewId:collectionViewId,labels:fieldT,
  prepare:async kind=>{await settleBodySave();return current()&&canRead()&&(kind==='read'?collectionRecovery||!state.conflict&&!bodySaveBlocked:canWrite());},
  onBusyChange:release,
  onModel:next=>{if(!current())return;const basis=pendingPages.get(next);if(!basis||room!==basis.activeRoom)throw new ApiError(409,'COLLECTION_READ_CHANGED');if(!basis.activeRoom){state.current=mergeSavedPageAttachments(state.current,basis.fresh);state.listRevision=basis.fresh.revision;}pendingPages.delete(next);state.collection=next;state.collectionError=state.recordError='';if(collectionRecovery){collectionRecovery=false;state.conflict=false;if(['unknown','refresh'].includes(bodySaveBlocked))bodySaveBlocked='';}updateDirty();},
  onSelected:id=>{collectionViewId=id;const url=new URL(location.href);if(id)url.searchParams.set('view',id);else url.searchParams.delete('view');history.replaceState(null,'',url);},
  confirmDiscard:confirmCollectionProperties,
  writeBoard:async(intent,{signal})=>{await collectionActor(actorId,signal);if(!current()||!canWrite())throw new ApiError(409,'COLLECTION_READ_CHANGED');const result=await request(collectionPath(collectionId)+(intent.viewId?'/views/'+encodeURIComponent(intent.viewId):'/records/'+encodeURIComponent(intent.recordId)),{method:'PATCH',body:intent.body,signal});await collectionActor(actorId,signal);return result;},
  onAccepted:(result,intent)=>{if(!current()||state.current.revision!==intent.body.expectedRevision)throw new ApiError(0,'INVALID_RESPONSE');state.collection.advanceDocumentBasis({expectedRevision:intent.body.expectedRevision,revision:result.revision,pageId,title:state.current.page.title});state.current.revision=result.revision;state.listRevision=result.revision;},
  onError:(error,{mutation,acknowledged,lost})=>{if(!current())return;if(lost){errorKey(error,'recordSaveFailed');state.collection=null;state.people=[];}else if(error.status===409){state.collection.markConflict();state.conflict=true;collectionRecovery=true;state.recordError='recordConflict';}else if(mutation&&(acknowledged||!error.status||error.status>=500)){state.collection.markUnknown();bodySaveBlocked=acknowledged?'refresh':'unknown';collectionRecovery=true;state.recordError='recordUnknown';}else state.recordError=error.code==='PROPERTY_DRAFT_CHANGED'?'embeddedPropertiesChanged':error.code==='NOTIFICATIONS_TOO_LARGE'?'assigneeNotificationLimit':errorKey(error,'recordSaveFailed');refreshSaveStatus();refreshPageFeedback();},
  projectionOptions:()=>({locale:fieldI18n.locale,people:state.people,pages:state.pages,
   tableRow:(record,index,{readOnly})=>recordEditor(record,index,{table:true,readOnly}),
   onOpenPage:record=>void selectPage(record.pageId),onEdit:record=>openCollectionRecord(record),onSource:openSourceCells,
   onBoardMove:(record,board)=>openCollectionBoardMove(controller,record,board),
  })
 });
 collectionView=controller;if(collectionRefresh&&!state.collection.dirty){collectionRefresh=false;void controller.refresh();}
}
async function confirmCollectionProperties(){
 if(modalOpen()||state.busy||roomCompositions.size)return false;
 return new Promise(resolve=>{let confirmed=false;showModal('confirmDiscardTitle',[node('p',{},fieldT('embeddedDiscardProperties')),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),button('discard',()=>{confirmed=true;modal.close();},{primary:true})])]);modal.addEventListener('close',()=>resolve(confirmed),{once:true});});
}
function openCollectionRecord(record){
 if(state.busy||modalOpen()||roomCompositions.size||!state.collection?.record(record.id))return;
 showModal('recordProperties',[node('h3',{translate:'no'},record.title||t('untitled')),node('p',{'data-record-feedback':'',role:'status'}),recordEditor(state.collection.record(record.id),state.collection.collection.records.findIndex(row=>row.id===record.id))]);
}
function openCollectionBoardMove(controller,record,model){
 if(room||state.busy||modalOpen()||state.collection?.dirty||!model.canMove(record.id))return;
 const envelope=state.collection.envelope,scope=collectionScope(),targets=model.targets,manual=model.canReorder(record.id);
 const label=value=>value===null?fieldT('empty'):value===''?fieldT('emptyText'):model.property.type==='checkbox'?fieldT(value?'yes':'no'):String(value);
 const target=node('select',{'aria-label':fieldT('boardDestination')},targets.map((value,index)=>node('option',{value:String(index)},label(value))));target.value=String(Math.max(0,targets.findIndex(value=>JSON.stringify(value)===JSON.stringify(record.values[model.property.id]))));
 const position=node('select',{'aria-label':fieldT('boardPosition')}),status=node('p',{class:'hint',role:'status'});let anchors=[];
 const positions=()=>{anchors=(model.groups.find(group=>JSON.stringify(group.value)===JSON.stringify(targets[Number(target.value)]))?.records??[]).filter(row=>row.id!==record.id);position.replaceChildren(node('option',{value:''},fieldT('boardAtEnd')),...anchors.map((row,index)=>node('option',{value:String(index)},fieldT('boardBefore',{text:row.title||t('untitled')}))));};positions();target.addEventListener('change',positions);
 const confirm=node('button',{type:'button',class:'button primary'},fieldT('boardMoveConfirm'));confirm.addEventListener('click',()=>{if(scope!==collectionScope()||state.collection.envelope!==envelope||!/^\d+$/.test(target.value)||Number(target.value)>=targets.length||manual&&position.value!==''&&(!/^\d+$/.test(position.value)||!anchors[Number(position.value)])){status.textContent=fieldT('boardTargetUnavailable');confirm.disabled=true;return;}const move={recordId:record.id,targetValue:targets[Number(target.value)],...(manual?{beforeRecordId:position.value===''?null:anchors[Number(position.value)].id}:{})};modal.close();void controller.moveBoard(move);});
 showModal('recordProperties',[node('h3',{},fieldT('boardMove')),node('p',{translate:'no'},record.title||t('untitled')),node('label',{class:'field'},[fieldT('boardDestination'),target]),...(manual?[node('label',{class:'field'},[fieldT('boardPosition'),position])]:[]),status,node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),confirm])]);
}
async function saveRecord(recordId) {
  if(!await settleBodySave())return;
  const model=state.collection;
  if (room || !model?.canEdit(recordId) || state.busy || state.loading || state.locked || state.conflict) return;
  let patch;
  try {patch=model.patch(recordId);}catch{state.recordError='recordInvalidValue';render();return;}
  if(!patch){model.discard(recordId);state.recordError='';updateDirty();render();return;}
  const marker=state.selection;
  state.busy=true; state.recordError=''; state.notice=''; render();
  try {
    const response=await request(collectionPath()+'/records/'+encodeURIComponent(recordId),{method:'PATCH',body:patch});
    if (marker!==state.selection || state.collection!==model) return;
    try {model.accept(response,recordId);}catch{throw new ApiError(0,'INVALID_RESPONSE');}
    state.current.revision=response.revision; state.listRevision=response.revision; state.notice='recordSaved';collectionRefresh=!model.dirty;
    if(modal.dataset.view==='recordProperties')modal.close();
  } catch(error) {
    if (marker!==state.selection) return;
    if (error.status===409) { model.markConflict(); state.conflict=true; state.recordError='recordConflict'; }
    else if(![400,401,403,404,413].includes(error.status)){model.markUnknown();bodySaveBlocked='unknown';state.recordError='recordUnknown';}
    else state.recordError=error.code==='NOTIFICATIONS_TOO_LARGE'?'assigneeNotificationLimit':errorKey(error,'recordSaveFailed');
  } finally { if(marker===state.selection) { state.busy=false; updateDirty(); render();const feedback=modal.querySelector('[data-record-feedback]');if(feedback)feedback.textContent=state.recordError?state.recordError==='assigneeNotificationLimit'?fieldT(state.recordError):t(state.recordError):''; } }
}

function focusBlock(id, offset = 0, end = offset) {
  requestAnimationFrame(() => {
    const target = [...app.querySelectorAll('.inline-editor')].find(input => input.dataset.blockId === id);
    if(target)focusInlineEditor(target, { start: offset, end });else focusTableCell({blockId:id,tableCell:{row:0,column:0},start:offset,end});
  });
}
function focusTableCell(selection){const target=[...app.querySelectorAll('.simple-table-cell')].find(input=>input.dataset.blockId===selection.blockId&&Number(input.dataset.tableRow)===selection.tableCell.row&&Number(input.dataset.tableColumn)===selection.tableCell.column);target?.focus({preventScroll:true});target?.setSelectionRange?.(selection.start||0,selection.end??selection.start??0);return target;}
function editorSelection() {
 const active=document.activeElement;
 if(active?.classList.contains('simple-table-cell'))return{blockId:active.dataset.blockId,tableCell:{row:Number(active.dataset.tableRow),column:Number(active.dataset.tableColumn)},start:active.selectionStart||0,end:active.selectionEnd||0};
 if(active?.classList.contains('inline-editor')) {const selection=captureInlineSelection(active);return selection?{blockId:active.dataset.blockId,...selection}:null;}
 if(active?.id==='page-title')return {title:true,start:active.selectionStart||0,end:active.selectionEnd||0};
 return null;
}
function rememberEditorSelection() {
 if(room){room.lastSelection=editorSelection()||room.lastSelection;return;}
 if(editorHistory && state.draft) {try{editorHistory.record(state.draft,{group:editorHistory.group,selection:editorSelection() || editorHistory.current.selection});}catch{editorHistory=null;state.error='historyUnavailable';}}
}
function applyEditorHistory(direction) {
 if(room){if(structureDisabled()||roomCompositions.size||modalOpen())return true;const selection=editorSelection()||room.lastSelection;try{state.draft=clone(room.client.history(direction));room.lastSelection=selection;presence.changed();updateDirty();render();if(selection?.blockId&&blockLocation(selection.blockId))focusBlock(selection.blockId,selection.start,selection.end);}catch{stopRoomInput(room);}return true;}
 if(!editorHistory || editingDisabled())return false;
 const entry=direction==='undo'?editorHistory.undo():editorHistory.redo();if(!entry)return true;
 state.draft=entry.draft;restoringHistory=true;render();restoringHistory=false;
 requestAnimationFrame(()=> {if(entry.selection?.title){const input=document.getElementById('page-title');input?.focus();input?.setSelectionRange(entry.selection.start,entry.selection.end);}else if(entry.selection?.tableCell)focusTableCell(entry.selection);else if(entry.selection?.blockId)focusBlock(entry.selection.blockId,entry.selection.start,entry.selection.end);});return true;
}
function choiceForBlock(block) {return block.type==='heading'?'heading'+Math.max(1,Math.min(3,block.data?.level||1)):block.type;}
function convertBlock(block,choice) {
 if(/^heading[123]$/.test(choice)) {block.type='heading';block.data={...block.data,level:Number(choice.at(-1))};}
 else {block.type=choice;if(['code','divider'].includes(choice) && block.data){delete block.data.marks;delete block.data.mentions;}if(choice==='checklist')block.data={...block.data,checked:block.data?.checked===true};if(choice==='numbered-list')block.data={...block.data,start:1};}
}
function openBlockPicker(existingId=null,target={parentId:null,index:state.draft.blocks.length}) {
 if(room&&existingId!==null)return;
 if(!structureAllowed(existingId || target.parentId))return;
 const existing=existingId===null?null:blockLocation(existingId)?.block;if(existingId!==null&&!existing)return;
 const menu=node('div',{class:'block-picker',role:'menu','aria-label':t('blockType')},blockChoices.map(choice=>{
  const parentType=/^heading[123]$/.test(choice)?'heading':choice;
  const blocked=!!room&&choice==='divider'||choice==='divider'&&!!existing?.data?.text || !!existing?.children?.length&&!EDITOR_PARENT_TYPES.includes(parentType);
  const option=button(choice,()=>{
   if(room&&choice==='divider'||!structureAllowed(existingId || target.parentId))return;rememberEditorSelection();
   try{
    let nextBlocks=clone(state.draft.blocks),block=existingId===null?{id:crypto.randomUUID(),type:'paragraph',data:{text:''}}:blockLocation(existingId,nextBlocks)?.block;if(!block)return;
    convertBlock(block,choice);let focusId=block.id;
    if(existingId===null)nextBlocks=insertEditorBlock(nextBlocks,{block,parentId:target.parentId,index:target.index});
    if(choice==='divider'){const current=blockLocation(block.id,nextBlocks),next={id:crypto.randomUUID(),type:'paragraph',data:{text:''}};nextBlocks=insertEditorBlock(nextBlocks,{block:next,parentId:current.parentId,index:current.index+1});focusId=next.id;}
    if(room){modal.close();finishTreeChange({blocks:nextBlocks,focus:{blockId:focusId,start:0}});}else{state.draft.blocks=nextBlocks;updateDirty();modal.close();render();focusBlock(focusId);}
   }catch(error){state.error=nestingError(error);modal.close();render();}
  },{class:'block-choice',disabled:blocked,title:t(room&&choice==='divider'?'roomStopFirst':blocked&&existing?.children?.length?'nesting.unsupportedParent':choice==='divider'?'dividerEmptyOnly':choice)});
  option.setAttribute('role','menuitem');return option;
 }));
 if(existingId===null){const option=button('simpleTable.add',()=>{if(room||!structureAllowed(target.parentId))return;rememberEditorSelection();try{const block={id:crypto.randomUUID(),type:'table',data:createSimpleTable()};state.draft.blocks=insertEditorBlock(state.draft.blocks,{block,parentId:target.parentId,index:target.index});updateDirty();modal.close();render();focusBlock(block.id);}catch(error){state.error=nestingError(error);modal.close();render();}},{class:'block-choice',disabled:!!room,title:room?t('simpleTable.roomReadOnly'):undefined});option.setAttribute('role','menuitem');menu.append(option);}
 for(const count of [2,3]){const allowed=!room&&(existingId===null?columnsAt(target.parentId):columnsAt(blockLocation(existingId)?.parentId)&&!blockHasColumns(existing));const option=button(count===2?'columns.addTwo':'columns.addThree',()=>addColumns(count,existingId,target),{class:'block-choice',disabled:!allowed,title:room?t('roomStopFirst'):!allowed?t('columns.nested'):undefined});option.setAttribute('role','menuitem');menu.append(option);}
 menu.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const choices=[...menu.querySelectorAll('button:not(:disabled)')],current=choices.indexOf(document.activeElement);const next=event.key==='Home'?0:event.key==='End'?choices.length-1:(current+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;choices[next]?.focus();});
 showModal(existingId===null?'addBlock':'blockType',[menu,node('p',{class:'hint'},t('blockKeys'))]);menu.querySelector('button:not(:disabled)')?.focus();
}
function blockHasColumns(block) {return ['columns','column'].includes(block?.type)||!!block?.children?.some(blockHasColumns);}
function blockHasPageAttachment(block) {return !!block?.data?.links?.some(link=>typeof link.attachmentId==='string')||!!block?.children?.some(blockHasPageAttachment);}
function deleteNestedBlock(blockId,confirmed=false) {
 if(!structureAllowed(blockId))return;const location=blockLocation(blockId);if(!location)return;
 if(location.block.children?.length&&!confirmed){const count=indexEditorBlocks([location.block]).size-1;showModal('deleteBlock',[node('p',{},t('nesting.deleteChildren',{count})),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),button('deleteBlock',()=>deleteNestedBlock(blockId,true))])]);return;}
 rememberEditorSelection();try{const fallback=location.siblings[location.index+1]?.id||location.siblings[location.index-1]?.id||location.parentId;modal.close();finishTreeChange({blocks:removeEditorBlock(state.draft.blocks,blockId,{confirmChildren:confirmed}),focus:fallback?{blockId:fallback,start:0}:null});}catch(error){state.error=nestingError(error);modal.close();render();}
}
function openBlockActions(blockId) {
 if(!structureAllowed(blockId))return;const location=blockLocation(blockId),block=location?.block;if(!block)return;
 if(block.type==='table'&&isSimpleTableData(block.data))return openSimpleTableActions(blockId);
 const capturedScope=blockDragScope(),active=room,conversionAllowed=choice=>{if(!active)return true;if(!active.client.supportsFeature('block-transforms'))return false;try{prepareRoomConvertOperation(state.draft.blocks,{blockId,choice,seedBlocks:active.client.seed.blocks});return true;}catch{return false;}};
 const select=node('select',{'aria-label':t('blockType'),disabled:!!room&&!room.client.supportsFeature('block-transforms')},blockChoices.map(choice=>node('option',{value:choice,disabled:!conversionAllowed(choice)||choice==='divider'&&!!block.data?.text||!!block.children?.length&&!EDITOR_PARENT_TYPES.includes(/^heading[123]$/.test(choice)?'heading':choice)},t(choice))));select.value=choiceForBlock(block);
 select.addEventListener('change',()=>{if(capturedScope!==blockDragScope()||room!==active||blockLocation(blockId)?.block!==block||!structureAllowed(blockId)||state.conflict||bodySaveBlocked)return;rememberEditorSelection();try{if(active){const operation=prepareRoomConvertOperation(state.draft.blocks,{blockId,choice:select.value,seedBlocks:active.client.seed.blocks});modal.close();finishRoomTransform({operation,focus:{blockId,start:0}});}else{convertBlock(block,select.value);updateDirty();modal.close();render();focusBlock(block.id);}}catch(error){state.error=nestingError(error);modal.close();render();}});
 const move=offset=>{if(!structureAllowed(blockId))return;const current=blockLocation(blockId),target=current.index+offset;if(target<0||target>=current.siblings.length)return;rememberEditorSelection();const blocks=moveEditorBlockTo(state.draft.blocks,{blockId,targetId:current.siblings[target].id,placement:offset<0?'before':'after'});modal.close();finishTreeChange({blocks,roomBlockIds:[blockId],focus:{blockId,start:0}});};
 const indent=nestingAvailability(blockId,'indent'),outdent=nestingAvailability(blockId,'outdent'),canParent=EDITOR_PARENT_TYPES.includes(block.type)&&location.depth<MAX_EDITOR_NESTING-1;
 showModal('blockType',[node('label',{class:'field'},[t('blockType'),select]),node('div',{class:'block-action-list'},[
  ...(blockLocation(blockId,state.current.document.blocks)?[node('a',{class:'button',href:'/comments.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(state.current.page.id)+'&block='+encodeURIComponent(blockId)},t('blockComments'))]:[button('blockComments',()=>{},{disabled:true,title:t('blockCommentSaveFirst')})]),
  button('moveUp',()=>move(-1),{disabled:location.index===0}),button('moveDown',()=>move(1),{disabled:location.index===location.siblings.length-1}),
  button('nesting.indent',()=>{modal.close();changeBlockNesting(blockId,'indent');},{disabled:!indent.enabled,title:indent.reason?t(indent.reason):undefined}),
  button('nesting.outdent',()=>{modal.close();changeBlockNesting(blockId,'outdent');},{disabled:!outdent.enabled,title:outdent.reason?t(outdent.reason):undefined}),
  button('nesting.addChild',()=>openBlockPicker(null,{parentId:blockId,index:block.children?.length||0}),{disabled:!canParent,title:t(canParent?'nesting.addChild':'nesting.unsupportedParent')}),
  button('columns.addTwo',()=>addColumns(2,blockId),{disabled:!!room||!columnsAt(location.parentId)||blockHasColumns(block),title:!columnsAt(location.parentId)?t('columns.nested'):undefined}),
  button('columns.addThree',()=>addColumns(3,blockId),{disabled:!!room||!columnsAt(location.parentId)||blockHasColumns(block),title:!columnsAt(location.parentId)?t('columns.nested'):undefined}),
  button('blockMove.inPage',()=>openInPageBlockMove(blockId)),
  button('moveBlockToPage',()=>void openBlockMove(blockId),{disabled:!canTransferSelection(blockId),title:!canTransferSelection(blockId)?t('blockTransfer.notAllowed'):undefined}),button('deleteBlock',()=>deleteNestedBlock(blockId))
 ]),node('p',{class:'hint'},t('nesting.keyboardHint'))]);
}
function openSimpleTableActions(blockId){
 if(room||!structureAllowed(blockId))return;const location=blockLocation(blockId);if(!location)return;
 const move=offset=>{if(room||!structureAllowed(blockId))return;const current=blockLocation(blockId),target=current.index+offset;if(target<0||target>=current.siblings.length)return;rememberEditorSelection();const blocks=moveEditorBlockTo(state.draft.blocks,{blockId,targetId:current.siblings[target].id,placement:offset<0?'before':'after'});modal.close();finishTreeChange({blocks,focus:{blockId,start:0}});};
 showModal('simpleTable.label',[node('div',{class:'block-action-list'},[button('moveUp',()=>move(-1),{disabled:location.index===0}),button('moveDown',()=>move(1),{disabled:location.index===location.siblings.length-1}),button('blockMove.inPage',()=>openInPageBlockMove(blockId)),button('moveBlockToPage',()=>void openBlockMove(blockId),{disabled:!canTransferSelection(blockId)}),button('deleteBlock',()=>deleteNestedBlock(blockId))])]);
}
function blockDragScope() {return state.current&&state.user?JSON.stringify([state.user.id,workspaceId,state.current.page.id,state.selection]):null;}
function canDragBlock(blockId) {
 return !!state.draft&&!draggedPageId&&!modalOpen()&&!structureDisabled()&&!state.conflict&&!bodySaveBlocked&&!wideBlockSelection()&&(!room||blockLocation(blockId)?.block.type!=='table')&&canEditNestedBlock(blockLocation(blockId));
}
function validBlockPageDrop(pageId) {return !room&&!state.busy&&pageId!==state.current?.page.id&&state.pages.some(page=>page.id===pageId&&page.capabilities.includes('editBody'));}
function commitBlockDrag(operation) {
 if(!canDragBlock(operation.blockId))return false;
 try{
  if(operation.blockIds){const plan=planEditorBlocksMove(state.draft.blocks,operation);if(!plan.changed)return false;}else createEditorMovePlanner(state.draft.blocks)(operation);
  const blocks=operation.blockIds?moveEditorBlocksTo(state.draft.blocks,operation):moveEditorBlockTo(state.draft.blocks,operation);rememberEditorSelection();
  finishTreeChange({blocks,roomBlockIds:operation.blockIds??[operation.blockId],focusHandle:operation.blockIds?.[0]||operation.blockId});return true;
 }catch(error){state.error=nestingError(error);refreshPageFeedback();return false;}
}
function openInPageBlockMove(blockId) {
 if(selectedBlockRoots().length>1&&blockCoveredBySelection(blockId)){openSelectedBlockMove();return;}
 if(!structureAllowed(blockId))return;rememberEditorSelection();
 const locations=indexEditorBlocks(state.draft.blocks),plan=createEditorMovePlanner(state.draft.blocks),positions=['before','after','inside'];
 const targets=[...locations.values()].filter(location=>positions.some(placement=>{try{plan({blockId,targetId:location.block.id,placement});return true;}catch{return false;}}));
 const label=location=>t('blockMove.targetLabel',{number:location.order+1,text:columnsTargetText(location).slice(0,80)});
 const target=node('select',{'aria-label':t('blockMove.target')},[node('option',{value:''},t('blockMove.end')),...targets.map(location=>node('option',{value:location.block.id,translate:'no'},label(location)))]);
 const position=node('select',{'aria-label':t('blockMove.position')});
 const current=state.draft,selection=state.selection,status=node('p',{class:'hint',role:'status'});
 const move=button('blockMove.apply',()=>{
  if(current!==state.draft || selection!==state.selection || !structureAllowed(blockId))return;
  const operation={blockId,targetId:target.value||null,placement:target.value?position.value:'end'};
  try{const blocks=moveEditorBlockTo(state.draft.blocks,operation);rememberEditorSelection();modal.close();finishTreeChange({blocks,roomBlockIds:[blockId],...(blockLocation(blockId)?.block.type==='columns'?{focusHandle:blockId}:{focus:{blockId,start:0}})});}catch(error){status.textContent=t(nestingError(error));}
 },{primary:true});
 const update=()=>{
  const selected=position.value;position.replaceChildren();
  if(target.value){for(const placement of positions){try{plan({blockId,targetId:target.value,placement});position.append(node('option',{value:placement},t('blockMove.'+placement)));}catch{}}}else position.append(node('option',{value:'end'},t('blockMove.end')));
  if([...position.options].some(option=>option.value===selected))position.value=selected;
  position.disabled=!target.value;move.disabled=!!target.value&&!position.options.length;status.textContent='';
 };
 target.addEventListener('change',update);update();
 showModal('blockMove.inPage',[node('p',{class:'hint'},t('blockMove.dialogHint')),node('label',{class:'field'},[t('blockMove.target'),target]),node('label',{class:'field'},[t('blockMove.position'),position]),status,node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),move])]);target.focus();
}
function transferSelection(blockId,blockIds) {
 const requested=blockIds??dragSelectionIds(blockId)??[blockId];
 return planBlockForestMove(state.draft.blocks,[],{blockIds:requested,index:0}).blockIds;
}
function canTransferSelection(blockId,blockIds) {
 if(room)return false;
 try{return transferSelection(blockId,blockIds).length>0;}catch{return false;}
}
function transferFailure(error) {
 if(error.code==='BLOCK_ATTACHMENTS_UNSUPPORTED')return 'blockAttachmentsUnsupported';
 if(error.code==='BLOCK_COLUMNS_NESTED')return 'columns.nested';
 if(error.code==='BLOCK_NESTING_LIMIT')return 'blockTransfer.depth';
 if(error.code==='BLOCK_NESTING_READ_ONLY'||error.code==='BLOCK_PARENT_UNSUPPORTED')return 'blockTransfer.readOnly';
 return 'blockTransfer.notAllowed';
}
function transferPreview(block) {
 return block?.type==='columns'?t('columns.group',{count:block.children.length}):block?.data?.text?.slice(0,160)||t('divider');
}
async function openBlockMove(blockId,suggestedTarget,capturedIds) {
 if(!structureAllowed(blockId))return;
 let blockIds;try{blockIds=transferSelection(blockId,capturedIds);}catch(error){state.error=transferFailure(error);refreshPageFeedback();return;}
 if(state.dirty) {
  showModal('moveBlockToPage',[node('p',{},t('saveBeforeBlockMove')),node('div',{class:'dialog-actions'},[
   button('cancel',()=>modal.close()),button('saveAndMoveBlock',async()=>{await closeModalFully();await savePage();if(!state.dirty && !state.conflict)await openBlockMove(blockId,suggestedTarget,blockIds);},{disabled:!!state.collection?.dirty || state.conflict || !bodyDirty()}),
   button('useSavedBlock',async()=>{await closeModalFully();if(!await confirmReplace(true))return;await selectPage(state.current.page.id,true,true);if(!state.dirty)await openBlockMove(blockId,suggestedTarget,blockIds);})
  ])]);return;
 }
 if(blockIds.some(id=>!blockLocation(id,state.current.document.blocks))){state.error='blockNotSaved';render();return;}
 const destinations=state.pages.filter(page=>page.id!==state.current.page.id && page.capabilities.includes('editBody'));
 const select=node('select',{'aria-label':t('blockDestination')},[node('option',{value:''},t('chooseBlockDestination')),...destinations.map(page=>node('option',{value:page.id,translate:'no'},page.title))]);
 if(suggestedTarget && destinations.some(page=>page.id===suggestedTarget))select.value=suggestedTarget;
 const status=node('p',{class:'hint',role:'status'}),review=button('reviewBlockMove',async()=> {
  if(!validId(select.value))return;const marker=state.selection,source=state.current;review.disabled=true;select.disabled=true;status.textContent=t('loading');
  try {
   const target=validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(select.value)),select.value);
   if(marker!==state.selection || !modal.open || modal.dataset.view!=='moveBlockToPage')return;
   if(!target.page.capabilities.includes('editBody'))throw new ApiError(404,'CONTENT_NOT_FOUND');
   createPageBlockTransfer(source,target,blockIds);
   const hasColumns=blockIds.some(id=>blockHasColumns(blockLocation(id,source.document.blocks).block));
   const locations=[...indexEditorBlocks(target.document.blocks).values()].filter(location=>canEditEditorParent(location)&&!(hasColumns&&[...location.ancestors,location.block].some(block=>['columns','column'].includes(block.type))));
   const parent=node('select',{'aria-label':t('blockTransfer.parent')},[node('option',{value:''},t('blockTransfer.pageBody')),...locations.map(location=>node('option',{value:location.block.id,translate:'no'},t('blockMove.targetLabel',{number:location.order+1,text:columnsTargetText(location).slice(0,80)})))]);
   const position=node('select',{'aria-label':t('blockMove.position')}),feedback=node('p',{class:'hint',role:'status'});
   let transfer=null;
   const confirm=button('confirmBlockMove',()=>{if(transfer)void moveBlockToServer(source,target,transfer);},{primary:true,disabled:true});
   const update=()=>{try{transfer=createPageBlockTransfer(source,target,blockIds,{parentBlockId:parent.value||null,index:Number(position.value)});feedback.textContent='';confirm.disabled=false;}catch(error){transfer=null;confirm.disabled=true;feedback.textContent=t(transferFailure(error));}};
   const updatePositions=()=>{const siblings=parent.value?indexEditorBlocks(target.document.blocks).get(parent.value)?.block.children||[]:target.document.blocks;position.replaceChildren(...siblings.map((block,index)=>node('option',{value:String(index)},t('blockTransfer.before',{text:transferPreview(block).slice(0,60)}))),node('option',{value:String(siblings.length)},t('blockMove.end')));position.value=String(siblings.length);update();};
   parent.addEventListener('change',updatePositions);position.addEventListener('change',update);updatePositions();
   showModal('confirmBlockMove',[node('dl',{class:'source-cell-list'},[node('dt',{},t('moveBlockSource')),node('dd',{translate:'no'},source.page.title),node('dt',{},t('blockDestination')),node('dd',{translate:'no'},target.page.title)]),
    node('p',{},t('blockTransfer.count',{count:blockIds.length})),node('div',{class:'block-move-preview'},blockIds.slice(0,5).map(id=>node('p',{translate:'no'},transferPreview(blockLocation(id,source.document.blocks).block)))),
    node('label',{class:'field'},[t('blockTransfer.parent'),parent]),node('label',{class:'field'},[t('blockMove.position'),position]),feedback,node('p',{class:'hint'},t('crossBlockMoveHint')),
    node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),button('blockTransfer.back',async()=>{await closeModalFully();await openBlockMove(blockId,target.page.id,blockIds);}),confirm])]);
   parent.focus();
  }catch(error){status.textContent=t(error.status===404?'operationAccessChanged':transferFailure(error));review.disabled=false;select.disabled=false;}
 },{primary:true,disabled:!validId(select.value)});
 select.addEventListener('change',()=>{review.disabled=!validId(select.value);});
 showModal('moveBlockToPage',[node('p',{},t('blockTransfer.count',{count:blockIds.length})),node('label',{class:'field'},[t('blockDestination'),select]),node('p',{class:'hint'},t('crossBlockMoveHint')),status,node('div',{class:'dialog-actions'},review)]);
 select.focus();
}
async function moveBlockToServer(source,target,transfer) {
 if(!await settleBodySave())return;
 if(room || state.busy || state.dirty || state.current?.page.id!==source.page.id)return;
 state.busy=true;for(const control of modal.querySelectorAll('button,select'))control.disabled=true;render();
 let committed=false;
 try {
  const result=await request(basePath()+'/'+encodeURIComponent(source.page.id)+'/blocks/move',{method:'POST',body:transfer.body});
  validatePageBlockTransferResult(result,transfer);committed=true;state.locked=true;
  modal.close();state.busy=false;
  if(!await refreshList())throw new ApiError(0,'MOVE_REFRESH_FAILED');
  await selectPage(source.page.id,true,true);
  if(state.current?.page.id!==source.page.id||state.current.document.version<result.sourceVersion)throw new ApiError(0,'MOVE_REFRESH_FAILED');
  state.notice='blockMoved';render();
 }catch(error){
  state.busy=false;
  if(committed){state.locked=true;bodySaveBlocked='refresh';state.error='blockTransfer.refreshFailed';}
  else if(error.status===0||error.status>=500||error.code==='INVALID_BLOCK_TRANSFER_RESPONSE'){state.locked=true;bodySaveBlocked='unknown';state.error='blockTransfer.unknown';}
  else if(/^BLOCK_|^INVALID_BLOCK_/.test(error.code||''))state.error=transferFailure(error);
  else state.error=errorKey(error,'blockMoveFailed');
  modal.close();render();
 }finally{state.busy=false;}
}

async function refreshList(announce = false) {
  await settleBodySave();
  if (!state.user || state.listLoading || state.busy || state.fatal) return;
  const marker = ++state.listGeneration;
  state.listLoading = true; render();
  try {
    const teamClient=new TeamspaceClient({workspaceId,accountId:state.user.id});
    const [data,teams]=await Promise.all([request(basePath()),teamClient.list().catch(error=>{if(error.code==='ACCOUNT_CHANGED')throw new ApiError(401,'ACCOUNT_CHANGED');return null;}).finally(()=>teamClient.destroy())]);
    if (marker !== state.listGeneration) return;
    if (data.workspaceId !== workspaceId || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
        !['owner', 'admin', 'member', 'guest'].includes(data.role) || !Array.isArray(data.pages) ||
        data.pages.some(page => !validId(page.id) || page.workspaceId !== workspaceId || typeof page.title !== 'string' || !Array.isArray(page.capabilities) || !page.capabilities.includes('read'))) throw new ApiError(0, 'INVALID_RESPONSE');
    state.pages = data.pages; state.listRevision = data.revision; state.role = data.role;
    state.teamspaces=teams?.teamspaces??[];state.teamsAvailable=!!teams;
    if (announce) { state.notice = 'listRefreshed'; state.error = ''; }
    return true;
  } catch (error) { if (marker === state.listGeneration) state.error = errorKey(error, 'listFailed'); return false; }
  finally { if (marker === state.listGeneration) { state.listLoading = false; render(); } }
}
async function selectPage(pageId, reload = false, discardConfirmed = false, ownsView = null) {
  await settleBodySave();
  if(ownsView&&!ownsView())return;
  if (state.busy || !validId(pageId) || (!reload && state.current?.page.id === pageId)) return;
  if (!discardConfirmed && !await confirmReplace(reload)) return;
  if(ownsView&&!ownsView())return;
  if(state.current&&state.current.page.id!==pageId){collectionViewId=null;collectionRecovery=false;collectionRefresh=false;}
  destroyRoom();
  const marker = ++state.selection;
  pageController?.abort(); pageController = new AbortController();
  state.loading = true; state.error = ''; state.notice = ''; render();
  try {
    const data = validatePageEnvelope(await request(basePath() + '/' + encodeURIComponent(pageId), { signal: pageController.signal }), pageId);
    if (marker !== state.selection) return;
    let collection = null, collectionError = '', people = [];
    if (validId(data.page.collectionId)) {
      try {
        const value = await request(collectionPath(data.page.collectionId), { signal: pageController.signal });
        collection = new CollectionEdits(value, { workspaceId, collectionId: data.page.collectionId });
        const currentRecord=data.page.recordId?collection.record(data.page.recordId):null;
        if(collection.revision!==data.revision || currentRecord&&(currentRecord.pageId!==pageId || currentRecord.title!==data.page.title))throw new ApiError(409,'COLLECTION_READ_CHANGED');
        if(collection.collection.properties.some(property=>property.type==='person')) {
          const containerId=collection.envelope.pageId;
          try {
            const candidates=await request(basePath()+'/'+encodeURIComponent(containerId)+'/people',{signal:pageController.signal});
            if(candidates?.pageId!==containerId || !Array.isArray(candidates.people) || candidates.people.length>1000 || candidates.people.some(person=>!validId(person.accountId)||typeof person.name!=='string'))throw new ApiError(0,'INVALID_RESPONSE');
            people=candidates.people;
          }catch(error){if(pageController.signal.aborted)throw error;collectionError='recordPeopleUnavailable';}
        }
      } catch (error) {
        if (state.current?.page.id === pageId && state.collection?.dirty) throw error;
        collection=null;people=[];collectionError=error.code==='COLLECTION_READ_CHANGED'?'collectionChanged':'collectionUnavailable';
      }
      if (marker !== state.selection) return;
    }
    state.collection = collection; state.collectionError = collectionError; state.recordError = ''; state.people=people;
    revealSidebarPage(state.pages,pageId,expandedSidebarPages);
    state.current = data; state.draft = { title: data.page.title, blocks: clone(data.document.blocks) };
    editorHistory=new EditorHistory(state.draft);
    state.dirty = false; state.conflict = false; state.locked = false; state.listRevision = data.revision;
    bodySaveBlocked='';observedDraft=JSON.stringify(state.draft);draftGeneration++;autosave.reset();
    state.navOpen = false;
    const viewUrl = new URL(location.href);
    if (viewUrl.searchParams.get('page') !== pageId){viewUrl.hash = '';viewUrl.searchParams.delete('view');}
    viewUrl.searchParams.set('page', pageId); history.replaceState(null, '', viewUrl);
    const found = state.pages.findIndex(page => page.id === pageId); if (found >= 0) state.pages[found] = data.page;
  } catch (error) { if (marker === state.selection && !pageController.signal.aborted) state.error = errorKey(error, 'loadFailed'); }
  finally { if (marker === state.selection) { state.loading = false; render(); focusContent(); } }
}
async function reloadPage() { if (state.current) await selectPage(state.current.page.id, true); }
async function savePage() {
  await autosave.flush();refreshSaveStatus();
}
async function persistPage({isCurrent}) {
  if(room||editingDisabled()||roomCompositions.size||modalOpen()||state.conflict||bodySaveBlocked||draggedBlockId||!bodyDirty())return {status:'paused'};
  const marker=state.selection,accountId=state.user.id,pageId=state.current.page.id;
  const submitted={expectedRevision:state.current.revision,expectedVersion:state.current.document.version,...clone(state.draft)};
  const current=()=>isCurrent()&&marker===state.selection&&accountId===state.user?.id&&state.current?.page.id===pageId;
  const task=(async()=>{
    // Keep the mounted editors, live draft objects and undo history intact while this snapshot saves.
    state.error='';state.notice='';
    try{
      const response=await request(basePath()+'/'+encodeURIComponent(pageId),{method:'PATCH',body:submitted});
      if(!current())return {status:'paused'};
      let data;try{data=validateSavedPage(submitted,validatePageEnvelope(response,pageId),{workspaceId,pageId});}
      catch{throw new ApiError(0,'INVALID_RESPONSE');}
      state.current=mergeSavedPageAttachments(state.current,data);state.listRevision=data.revision;
      // A permission projection may hide a link in the acknowledgement. Keep the live input for review.
      if(!pageBlocksEqual(data.document.blocks,submitted.blocks))state.conflict=true;
      if(state.collection){try{state.collection.advanceDocumentBasis({expectedRevision:submitted.expectedRevision,revision:data.revision,pageId,title:data.page.title});}
        catch{state.collection.markConflict();state.recordError='recordConflict';state.conflict=true;}}
      if(operation&&!operation.pending&&operation.revision===submitted.expectedRevision)operation.revision=data.revision;
      const found=state.pages.findIndex(page=>page.id===pageId);if(found>=0)state.pages[found]=data.page;
      const label=app.querySelector('.page-list [aria-current="page"] span');if(label)label.textContent=data.page.title;
      const version=app.querySelector('[data-document-version]');if(version)version.textContent=t('version',{version:data.document.version});
      return {status:state.conflict?'conflict':'saved'};
    }catch(error){
      if(!current())return {status:'paused'};
      if(error.status===409){state.conflict=true;state.error='conflict';return {status:'conflict'};}
      if([400,401,403,404,413].includes(error.status)){state.error=errorKey(error,'saveFailed');bodySaveBlocked='rejected';return {status:'rejected'};}
      bodySaveBlocked='unknown';state.error='saveUnknown';return {status:'unknown'};
    }
  })();
  bodySaveTask=task;refreshSaveStatus();refreshPageFeedback();
  try{return await task;}finally{
    if(bodySaveTask===task)bodySaveTask=null;
    if(current()){updateDirty();refreshPageFeedback();}
  }
}
async function openCreate(teamspaceId=null) {
  if (room || !state.user || state.busy || state.listLoading || state.role === 'guest' || state.locked || state.fatal || !await confirmReplace()) return;
  const input = node('input', { type: 'text', id: 'new-page-title', maxlength: '240', required: true, value: t('newPage'), autocomplete: 'off' });
  const team=teamspaceId?state.teamspaces.find(item=>item.id===teamspaceId&&item.capabilities.includes('createPage')&&!item.archivedAt):null;
  if(teamspaceId&&!team)return;
  const message = node('p', { class: 'hint' }, team?t('teamspaces.createPageHint',{name:team.name}):t('privateDefault'));
  const form = node('form', { class: 'create-form' }, [
    node('label', { class: 'field', for: 'new-page-title' }, [node('span', {}, t('pageTitle')), input]), message,
    node('div', { class: 'dialog-actions' }, [button('cancel', () => modal.close()), node('button', { type: 'submit', class: 'button primary' }, t('create'))])
  ]);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!input.value.trim()) { input.setCustomValidity(t('titleRequired')); input.reportValidity(); return; }
    void createPage(input.value,teamspaceId);
  });
  input.addEventListener('input', () => input.setCustomValidity(''));
  showModal('createPage', form); input.focus(); input.select();
}
async function createPage(title,teamspaceId=null) {
  if(!await settleBodySave())return;
  if (room || state.busy || state.listLoading) return;
  state.busy = true; state.error = ''; state.notice = '';
  for (const control of modal.querySelectorAll('button,input')) control.disabled = true;
  render();
  const accountId=state.user?.id,selection=state.selection,previousPageId=state.current?.page.id,generation=draftGeneration;
  const ownsView=()=>state.user?.id===accountId&&state.selection===selection&&state.current?.page.id===previousPageId&&draftGeneration===generation;
  let createdId,acknowledged=false;
  try {
    const submitted={expectedRevision:state.listRevision,title,blocks:[{id:crypto.randomUUID(),type:'paragraph',data:{text:''}}],...(teamspaceId?{teamspaceId}:{})};
    const data=validateCreatedPage(submitted,await request(basePath(),{method:'POST',body:submitted}),{workspaceId});
    acknowledged=true;if(!ownsView())return;
    validateCreatedPageProjection(data,validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(data.page.id)),data.page.id),{workspaceId,teamspaceId});
    if(!ownsView())return;
    createdId = data.page.id; state.listRevision = data.revision;
    // Only a successful creation replaces the previous tab draft.
    modal.close(); state.notice = 'created';
  } catch (error) {
    if(!ownsView())return;
    const unknown=acknowledged||error.status===0||error.status>=500||error.code==='INVALID_CREATE_RESPONSE';
    state.error = unknown?'teamspaces.createUnknown':error.status === 409 ? 'createConflict' : errorKey(error, 'createFailed');
    if(unknown){state.locked=true;bodySaveBlocked='unknown';for(const control of modal.querySelectorAll('.dialog-header button,.create-form button[type="button"]'))control.disabled=false;}
    else for (const control of modal.querySelectorAll('button,input')) control.disabled = false;
    const message = modal.querySelector('.hint'); if (message) { message.textContent = t(state.error); message.setAttribute('role', 'alert'); }
  } finally { state.busy = false; render(); }
  if (createdId&&ownsView()) { if(!await refreshList()||!ownsView())return;await selectPage(createdId, false, true,ownsView);if(state.user?.id===accountId&&state.current?.page.id===createdId&&state.draft.blocks[0])focusBlock(state.draft.blocks[0].id); }
}
async function openPageTeamspaceMove(page){
 if(room||state.busy||state.loading||!canManagePage(page)||page.recordId||state.dirty||!state.current||state.current.page.id!==page.id)return;
 const accountId=state.user.id,selection=state.selection,version=state.current.document.version;
 await closeModalFully();if(room||state.busy||selection!==state.selection||state.user?.id!==accountId)return;
 const client=new TeamspaceClient({workspaceId,accountId}),panel=node('div',{class:'teamspace-page-transfer'});
 let closed=false,pending=false,review=null,destination=null,ownedSelection=selection;
 const ownsView=()=>state.user?.id===accountId&&state.selection===ownedSelection&&state.current?.page.id===page.id;
 const current=()=>!closed&&ownsView();
 const status=node('p',{role:'status',class:'hint'},t('teamspaces.loading'));
 const cancel=event=>{if(pending)event.preventDefault();};
 const cleanup=()=>{closed=true;client.destroy();modal.removeEventListener('cancel',cancel);state.busy=false;};
 modal.addEventListener('cancel',cancel);modal.addEventListener('close',cleanup,{once:true});
 showModal('teamspaces.movePage',panel);panel.append(status);
 const controls=disabled=>{for(const control of modal.querySelectorAll('button,input,select'))control.disabled=disabled;};
 const fail=error=>{
  if(!current())return;pending=false;state.busy=false;
  if(client.uncertain){state.locked=true;bodySaveBlocked='unknown';state.error='teamspaces.moveUnknown';}
  panel.replaceChildren(node('p',{role:'alert',class:'hint'},t(client.uncertain?'teamspaces.moveUnknown':error.status===409?'teamspaces.moveChanged':'teamspaces.moveFailed')),node('div',{class:'dialog-actions'},[button('close',()=>modal.close()),...(!client.uncertain?[button('teamspaces.reload',async()=>{await closeModalFully();await reloadPage();})]:[])]));controls(false);render();
 };
 try{
  const directory=await client.list();if(!current())return;
  const eligible=directory.teamspaces.filter(team=>!team.archivedAt&&team.capabilities.includes('createPage'));
  destination=page.teamspaceId??'';
  const select=node('select',{id:'page-teamspace-target',onChange:event=>{destination=event.target.value;}},[
   node('option',{value:''},t('teamspaces.withoutTeamspace')),...eligible.map(team=>node('option',{value:team.id},team.name))
  ]);select.value=destination;
  if(select.value!==destination){destination='';select.value='';}
  const reviewButton=button('teamspaces.review',async()=>{
   if(!current()||pending)return;pending=true;state.busy=true;controls(true);
   try{
    review=await client.reviewPage(page.id,{expectedRevision:directory.revision,expectedVersion:version,teamspaceId:destination||null});if(!current())return;
    pending=false;state.busy=false;controls(false);
    const accepted=node('input',{type:'checkbox',id:'teamspace-move-consent'});
    const confirm=button('teamspaces.confirmMove',async()=>{
     if(!current()||pending||!accepted.checked||!review)return;pending=true;state.busy=true;controls(true);render();
     try{
      const result=await client.movePage(page.id,{expectedRevision:review.revision,expectedVersion:review.pageVersion,teamspaceId:review.teamspaceId,reviewDigest:review.reviewDigest,confirmAccessChange:true});
      if(!current())return;
      if(result.affectedPageCount!==review.affectedPageCount){client.uncertain=true;throw new ApiError(0,'INVALID_RESPONSE');}
      state.locked=true;bodySaveBlocked='refresh';state.busy=false;pending=false;modal.close();
      const refreshed=await refreshList(true);if(!ownsView())return;if(!refreshed)throw new ApiError(0,'MOVE_REFRESH_FAILED');
      if(state.pages.some(item=>item.id===page.id)){ownedSelection=state.selection+1;await selectPage(page.id,true,true);if(!ownsView())return;if(state.current.document.version<=version||state.current.page.teamspaceId!==result.teamspaceId)throw new ApiError(0,'MOVE_REFRESH_FAILED');}
      else{state.current=null;state.draft=null;state.collection=null;state.dirty=false;state.locked=false;bodySaveBlocked='';render();}
      state.notice='teamspaces.moved';render();
     }catch(error){if(closed){if(!ownsView())return;state.locked=true;bodySaveBlocked='refresh';state.error='teamspaces.refreshFailed';state.busy=false;render();}else fail(error);}
    },{primary:true,disabled:true});
    accepted.addEventListener('change',()=>{confirm.disabled=!accepted.checked||pending;});
    const selectedName=eligible.find(team=>team.id===review.teamspaceId)?.name||t('teamspaces.withoutTeamspace');
    panel.replaceChildren(node('p',{translate:'no',class:'operation-page-title'},page.title),node('dl',{class:'settings-facts'},[
     node('div',{},[node('dt',{},t('teamspaces.destination')),node('dd',{translate:'no'},selectedName)]),
     ...[['affectedPageCount','affected'],['beforeReaders','beforeReaders'],['afterReaders','afterReaders'],['addedReaders','addedReaders'],['removedReaders','removedReaders'],['outsideReadersPreserved','preservedReaders']].map(([key,label])=>node('div',{},[node('dt',{},t('teamspaces.'+label)),node('dd',{},String(review[key]))]))
    ]),node('p',{class:'hint'},t('teamspaces.preserveGrants')),...(review.teamspaceOwnersHaveFullAccess?[node('p',{class:'hint'},t('teamspaces.ownersFull'))]:[]),...(!review.actorCanReadAfter?[node('p',{role:'alert'},t('teamspaces.loseRead'))]:!review.actorCanManageAfter?[node('p',{role:'alert'},t('teamspaces.loseManage'))]:[]),node('label',{class:'teamspace-move-consent',for:'teamspace-move-consent'},[accepted,node('span',{},t('teamspaces.confirmAccess'))]),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),confirm]));
   }catch(error){fail(error);}
  },{primary:true});
  panel.replaceChildren(node('p',{translate:'no'},page.title),node('label',{class:'field',for:'page-teamspace-target'},[node('span',{},t('teamspaces.destination')),select]),node('p',{class:'hint'},t('teamspaces.moveHint')),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),reviewButton]));
 }catch(error){fail(error);}
}
function canManagePage(page) { return state.role!=='guest' && page?.capabilities?.includes('manage') && !state.locked; }
function startPageDrag(event,page) {
  if(room || draggedBlockId || !canManagePage(page) || page.recordId || state.busy) { event.preventDefault(); return; }
  draggedPageId=page.id; event.dataTransfer.setData('application/x-yumunio-page',page.id); event.dataTransfer.effectAllowed='move'; app.classList.add('page-dragging');
}
function endPageDrag() { draggedPageId=null; app.classList.remove('page-dragging'); for(const item of app.querySelectorAll('.drop-target'))item.classList.remove('drop-target'); }
function validPageDrop(targetId) { if(room)return false;return draggedPageId && (targetId===null || pageMoveTargets(state.pages,draggedPageId).some(page=>page.id===targetId)); }
function overPageDrop(event,targetId) { if(!validPageDrop(targetId))return; event.preventDefault();event.dataTransfer.dropEffect='move';event.currentTarget.classList.add('drop-target'); }
function dropPage(event,targetId) { if(!validPageDrop(targetId) || event.dataTransfer.getData('application/x-yumunio-page')!==draggedPageId)return;event.preventDefault();const page=state.pages.find(item=>item.id===draggedPageId);endPageDrag();openPageOperation('move',page,targetId); }
function openPageActions() {
  if(!state.current || state.busy)return;
  const page=state.current.page, manageable=canManagePage(page);
  showModal('pageActions',[
    node('p',{translate:'no',class:'operation-page-title'},page.title),
    node('a',{href:'/share.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pageSharing')),
    node('a',{href:'/comments.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pageComments')),
    ...(page.capabilities?.includes('manage')&&!state.locked?[!room&&!state.dirty?node('a',{href:'/publication.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pagePublication')):button('pagePublication',()=>{},{disabled:true,title:t(room?'publicationStopRoom':'publicationSaveFirst')})]:[]),
    ...(canEdit()?[!room&&!state.dirty?node('a',{href:'/attachments.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pageAttachments')):button('pageAttachments',()=>{},{disabled:true,title:t(room?'attachmentStopRoom':'attachmentSaveFirst')})]:[]),
    ...(validId(page.collectionId)?[node('a',{href:'/collections.html?workspace='+encodeURIComponent(workspaceId)+'&collection='+encodeURIComponent(page.collectionId),class:'button'},t('openCollection'))]:[]),
    ...(manageable?[node('a',{href:'/history.html?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pageHistory'))]:[]),
    button('movePage',()=>openPageOperation('move',page),{icon:'arrow',disabled:!!room || !manageable || !!page.recordId,title:t(room?'roomStopFirst':page.recordId?'recordCannotMove':'manageRequired')}),
    button('teamspaces.movePage',()=>void openPageTeamspaceMove(page),{icon:'account',disabled:!!room||!manageable||!!page.recordId||state.dirty,title:t(room?'roomStopFirst':'teamspaces.saveBeforeMove')}),
    button('trashPage',()=>openPageOperation('trash',page),{icon:'trash',disabled:!!room || !manageable,title:t(room?'roomStopFirst':'manageRequired')}),
    node('p',{class:'hint'},t(page.recordId?'recordCannotMove':'pageOperationHint'))
  ]);
}
function openPageOperation(action,page,parentId) {
  if(room || state.busy || !page || (action==='restore'?!page.capabilities?.includes('restore'):!canManagePage(page)))return;
  operation={action,page,parent:parentId===undefined?(action==='restore'?'previous':page.parentId??''):parentId??'',inherit:false,revision:action==='restore'?page.trashRevision:state.listRevision,pending:false,error:'',recheck:false,unavailable:false};
  renderPageOperation();
}
function operationError(error) {
  if(error.code==='COLLECTION_ROW_LOCATION')return 'recordCannotMove';
  if(error.code==='HIERARCHY_CYCLE')return 'moveCycle';
  if(error.code==='LAST_PAGE_MANAGER')return 'lastPageManager';
  if(error.status===409)return 'operationConflict';
  if([401,403,404].includes(error.status))return 'operationAccessChanged';
  return 'operationUncertain';
}
function renderPageOperation() {
  const op=operation;if(!op)return;
  const targets=op.action==='restore'?state.pages.filter(page=>canManagePage(page)):pageMoveTargets(state.pages,op.page.id);
  const parent=node('select',{'aria-label':t('moveDestination')},[
    ...(op.action==='restore'?[node('option',{value:'previous'},t('previousLocation'))]:[]),node('option',{value:''},t('workspaceTop')),
    ...targets.map(page=>node('option',{value:page.id,translate:'no'},page.title))
  ]);
  parent.value=op.parent;if(parent.value!==op.parent) {op.parent=op.action==='restore'?'previous':'';parent.value=op.parent;}
  parent.addEventListener('change',()=> {op.parent=parent.value;op.inherit=false;renderPageOperation();});
  const inherit=node('input',{type:'checkbox',checked:op.inherit,disabled:!op.parent}); inherit.addEventListener('change',()=>op.inherit=inherit.checked);
  const title={move:'movePage',trash:'trashPage',restore:'restorePage'}[op.action];
  const content=[node('p',{translate:'no',class:'operation-page-title'},op.page.title),node('p',{},t(op.action==='trash'?'trashPageHint':op.action==='restore'?'restorePageHint':'movePageHint'))];
  if(op.action!=='trash')content.push(node('label',{class:'field'},[t('moveDestination'),parent]),node('label',{class:'acknowledgement'},[inherit,node('span',{},t('inheritPermissions'))]),node('p',{class:'hint'},t('inheritPermissionsHint')));
  if(op.action==='restore')content.push(node('p',{class:'hint'},t('restorePageCount',{count:op.page.pageCount})));
  if(op.error)content.push(node('p',{class:'message',role:'alert'},t(op.error)));
  const submit=button(title,()=>void executePageOperation(),{primary:true,disabled:op.pending || op.recheck || op.unavailable});
  content.push(node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close(),{disabled:op.pending}),...(op.recheck?[button('reviewLatestPages',()=>void recheckPageOperation(),{disabled:op.pending})]:[]),submit]));
  showModal(title,content);modal.setAttribute('aria-busy',String(op.pending));
  if(op.pending)for(const control of modal.querySelectorAll('input,select,button'))control.disabled=true;
}
async function recheckPageOperation() {
  const op=operation;if(!op || state.busy || op.pending)return;op.pending=true;renderPageOperation();
  try {
    if(!await refreshList())throw new ApiError(0,'LIST_FAILED');
    if(op.action==='restore') {
      const data=await request(workspaceApi('/trash'));validateTrash(data);const page=data.pages.find(page=>page.id===op.page.id);
      if(!page) {op.unavailable=true;op.error='operationResultCheck';return;}op.page={...page,trashRevision:data.revision};op.revision=data.revision;
    }else {
      const page=state.pages.find(page=>page.id===op.page.id);if(!page){op.unavailable=true;op.error='operationResultCheck';return;}op.page=page;op.revision=state.listRevision;
    }
    op.inherit=false;op.error='operationReviewed';op.recheck=false;
  }catch(error){op.error=operationError(error);}finally{op.pending=false;renderPageOperation();}
}
function clearCurrentPage() {collectionView?.destroy();collectionView=null;collectionViewId=null;collectionRecovery=false;collectionRefresh=false;editorHistory=null;state.current=null;state.draft=null;state.collection=null;state.collectionError='';state.recordError='';state.people=[];state.dirty=false;state.conflict=false;const url=new URL(location.href);url.searchParams.delete('page');url.searchParams.delete('view');url.hash='';history.replaceState(null,'',url);}
async function executePageOperation() {
  if(!await settleBodySave())return;
  const op=operation;if(!op || op.pending || op.recheck || op.unavailable || state.busy)return;
  if(!await confirmReplace()) {renderPageOperation();return;}
  op.pending=true;state.busy=true;renderPageOperation();render();
  try {
    const suffix=op.action==='move'?'/location':op.action==='restore'?'/restore':'';
    const body={expectedRevision:op.revision,...(op.action==='trash'?{}:{...(op.parent==='previous'?{}:{parentId:op.parent||null}),inheritPermissions:op.inherit===true})};
    const result=await request(basePath()+'/'+encodeURIComponent(op.page.id)+suffix,{method:op.action==='move'?'PATCH':op.action==='restore'?'POST':'DELETE',body});
    if(result?.pageId!==op.page.id || !Number.isSafeInteger(result.revision) || result.revision<=op.revision || !Number.isSafeInteger(result.affectedPageCount) || result.affectedPageCount<1)throw new ApiError(0,'INVALID_RESPONSE');
    modal.close();operation=null;state.busy=false;state.conflict=!!state.current;
    const refreshed=await refreshList();
    if(refreshed) {
      const selected=op.action==='trash'?state.current?.page.id:op.page.id;
      if(selected && state.pages.some(page=>page.id===selected))await selectPage(selected,true,true);
      else clearCurrentPage();
    }
    state.notice={move:'moveDone',trash:'trashDone',restore:'restoreDone'}[op.action];state.noticeValues={count:result.affectedPageCount};render();
  }catch(error){op.error=operationError(error);op.recheck=true;}
  finally{state.busy=false;if(operation===op){op.pending=false;renderPageOperation();render();}}
}
function workspaceApi(suffix) {return '/api/content/workspaces/'+encodeURIComponent(workspaceId)+suffix;}
function validateTrash(data) {
  if(data?.workspaceId!==workspaceId || !Number.isSafeInteger(data.revision) || !Array.isArray(data.pages) || data.pages.some(page=>!validId(page.id)||typeof page.title!=='string'||!page.capabilities?.includes('restore')||!Number.isSafeInteger(page.pageCount)||page.pageCount<1))throw new ApiError(0,'INVALID_RESPONSE');return data;
}
async function openTrash() {
  if(state.busy || !state.user)return;
  showModal('trashPages',[node('p',{class:'hint',role:'status'},t('loading'))]);
  try {
    const data=validateTrash(await request(workspaceApi('/trash')));
    if(!modal.open || modal.dataset.view!=='trashPages')return;
    const list=node('ul',{class:'operation-list'},data.pages.map(page=>node('li',{},[node('div',{},[node('strong',{translate:'no'},page.title),node('p',{class:'hint'},t('restorePageCount',{count:page.pageCount}))]),button('restorePage',()=>openPageOperation('restore',{...page,trashRevision:data.revision}))])));
    modal.querySelector('.dialog-body').replaceChildren(node('p',{class:'hint'},t('trashScope')),data.pages.length?list:node('p',{},t(state.role==='guest'?'trashGuest':'trashEmpty')));
  }catch(error){if(modal.open && modal.dataset.view==='trashPages')modal.querySelector('.dialog-body').replaceChildren(node('p',{role:'alert'},t('trashFailed')));}
}
function openSearch() {
  if(state.busy || !state.user)return;searchController?.abort();searchGeneration++;
  const input=node('input',{type:'search',id:'page-search',value:searchQuery,maxlength:'100',autocomplete:'off','aria-label':t('searchQuery')});
  const results=node('div',{class:'search-results',id:'page-search-results','aria-live':'polite'});
  const submit=node('button',{type:'submit',class:'button primary'},t('searchPages'));
  const form=node('form',{class:'workspace-search-form'},[node('label',{class:'field',for:'page-search'},[t('searchQuery'),input]),submit]);
  form.addEventListener('submit',event=>{event.preventDefault();void searchPages(input.value,results,submit);});
  showModal('searchPages',[form,node('p',{class:'hint'},t('searchScope')),results]);renderSearchResults(results);input.focus();
}
function renderSearchResults(container) {
  if(!searchResults){container.replaceChildren();return;}
  const list=node('ul',{class:'search-result-list'},searchResults.results.map(result=>node('li',{},node('button',{type:'button',class:'search-result',onClick:async()=>{await closeModalFully();await selectPage(result.page.id);}},[node('strong',{translate:'no'},result.page.title),node('span',{translate:'no'},result.snippet)]))));
  container.replaceChildren(searchResults.results.length?list:node('p',{},t('searchEmpty')),...(searchResults.truncated?[node('p',{class:'hint'},t('searchTruncated'))]:[]));
}
async function searchPages(query,container,submit) {
  if(!query.trim())return;searchQuery=query;const marker=++searchGeneration;searchController?.abort();searchController=new AbortController();submit.disabled=true;container.replaceChildren(node('p',{role:'status'},t('loading')));
  try {
    const data=await request(workspaceApi('/search?q='+encodeURIComponent(query)),{signal:searchController.signal});
    if(marker!==searchGeneration)return;
    if(data?.workspaceId!==workspaceId || !Number.isSafeInteger(data.revision) || !Array.isArray(data.results) || typeof data.truncated!=='boolean'||data.results.some(result=>!validId(result.page?.id)||typeof result.page.title!=='string'||typeof result.snippet!=='string'))throw new ApiError(0,'INVALID_RESPONSE');
    searchResults=data;if(modal.open && modal.dataset.view==='searchPages')renderSearchResults(container);
  }catch(error){if(marker===searchGeneration && modal.open && modal.dataset.view==='searchPages')container.replaceChildren(node('p',{role:'alert'},t('searchFailed')));}
  finally{if(marker===searchGeneration)submit.disabled=false;}
}
function openExport() {
  if(state.busy || !state.user)return;
  const format=node('select',{'aria-label':t('exportFormat')},[node('option',{value:'json'},t('exportJson')),node('option',{value:'zip'},t('exportZip'))]);
  const status=node('p',{role:'status',class:'hint'}),download=button('downloadExport',()=>void downloadWorkspace(format.value,status,download,format),{primary:true});
  showModal('exportWorkspace',[node('p',{},t('exportScope')),node('p',{class:'message'},t('exportLimitations')),node('p',{class:'hint'},t('exportCsvSafety')),
    ...(state.dirty?[node('p',{class:'hint'},t('exportUnsaved'))]:[]),node('label',{class:'field'},[t('exportFormat'),format]),status,node('div',{class:'dialog-actions'},download)]);
  modal.addEventListener('close',()=>exportController?.abort(),{once:true});
}
async function downloadWorkspace(format,status,button,select) {
  if(!['json','zip'].includes(format))return;exportController?.abort();exportController=new AbortController();button.disabled=true;select.disabled=true;status.textContent=t('exportWorking');
  try {
    const response=await fetch(workspaceApi('/export?format='+format),{credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([exportController.signal,AbortSignal.timeout(30000)])});
    if(!response.ok)throw new ApiError(response.status,(await response.json()).error?.code);
    if(Number(response.headers.get('Content-Length'))>16*1024*1024)throw new ApiError(413,'CONTENT_TOO_LARGE');
    const bytes=await response.arrayBuffer();if(bytes.byteLength>16*1024*1024)throw new ApiError(413,'CONTENT_TOO_LARGE');
    if(!modal.open || modal.dataset.view!=='exportWorkspace')return;
    const filename=/filename="(yumunio-account-[0-9-]+\.(?:json|zip))"/.exec(response.headers.get('Content-Disposition')||'')?.[1]||'yumunio-account.'+format;
    const url=URL.createObjectURL(new Blob([bytes],{type:format==='zip'?'application/zip':'application/json'})),link=node('a',{href:url,download:filename});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);status.textContent=t('exportStarted');
  }catch(error){if(modal.open && modal.dataset.view==='exportWorkspace')status.textContent=t(error.status===413?'exportTooLarge':'exportFailed');}
  finally{button.disabled=false;select.disabled=false;}
}

function openAppearance(){openSettings('appearance');}
function openWorkspacePicker(){
 if(!state.user||state.fatal||state.busy||modalOpen()||roomCompositions.size)return;
 blockDnd?.cancel();rememberEditorSelection();const accountId=state.user.id;let nextSettings=null;
 workspacePicker=mountWorkspacePicker({background:app,workspaceId,expectedAccountId:accountId,labels:key=>t('workspacePicker.'+key),
  onNavigate:async href=>{const target=new URL(href,location.href);if(target.origin!==location.origin||state.user?.id!==accountId)return false;
   const settings=settingsHrefSection(target.href,workspaceId);if(settings){nextSettings=settings;return true;}
   if(target.pathname==='/workspace.html'&&target.searchParams.get('workspace')===workspaceId)return true;
   if(!await confirmReplace()||state.user?.id!==accountId)return false;
   destroyRoom();autosave.stop();state.dirty=false;bodySaveBlocked='';location.assign(target.href);return true;
  },onClose:()=>{workspacePicker=null;autosave.refresh();presence.paint();if(nextSettings){const section=nextSettings;queueMicrotask(()=>{if(state.user?.id===accountId&&!modalOpen())openSettings(section);});}}
 });autosave.refresh();presence.paint();
}
async function refreshPolicyAfterSettings(accountId){
 if(state.user?.id!==accountId)return;
 const marker=state.selection,pageId=state.current?.page.id,baseline=state.current,hadRoom=!!room,held=state.dirty||bodyDirty()||state.collection?.dirty;
 const current=()=>state.user?.id===accountId&&state.selection===marker&&state.current?.page.id===pageId;
 destroyRoom();if(pageId){bodySaveBlocked='refresh';state.locked=true;}autosave.refresh();
 if(!await refreshList(true)||!pageId||!current())return;
 if(!state.pages.some(page=>page.id===pageId)){if(held){state.error='teamspaces.heldInput';render();}else{state.current=null;state.draft=null;state.collection=null;state.dirty=false;state.locked=false;bodySaveBlocked='';render();}return;}
 if(!held){await selectPage(pageId,true,true);return;}
 try{
  const fresh=validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(pageId)),pageId);if(!current())return;
  if(!hadRoom&&!state.collection&&fresh.page.title===baseline.page.title&&pageBlocksEqual(fresh.document.blocks,baseline.document.blocks)&&fresh.page.capabilities.includes('editBody')){
   state.current=fresh;state.listRevision=fresh.revision;state.locked=false;state.conflict=false;bodySaveBlocked='';state.notice='teamspaces.refreshed';state.error='';render();autosave.refresh();return;
  }
  state.error='teamspaces.heldInput';state.notice='';render();
 }catch{if(current()){state.error='teamspaces.heldInput';render();}}
}
async function openWorkspaceHome(){
 if(!state.user||state.busy||modalOpen())return;const actorId=state.user.id,selection=state.selection;
 if(!await confirmReplace()||state.user?.id!==actorId||state.selection!==selection)return;
 destroyRoom();state.selection++;pageController?.abort();pageController=null;state.loading=false;clearCurrentPage();state.locked=false;bodySaveBlocked='';render();autosave.refresh();
}
function openResourceSharing(){if(!state.current)return;openSettings('members',null,{kind:state.collection&&!state.current.page.recordId?'collection':'page',title:state.current.page.title||t('untitled')});}
function openSettings(section='appearance',teamspaceId=null,resource=null){
 if(settingsDialog?.open){settingsDialog.requestSection(section);return;}
 if(!state.user||state.fatal||state.busy||roomCompositions.size)return;
 if(modal.open)return;
 blockDnd?.cancel();rememberEditorSelection();
 const accountId=state.user.id,pageId=state.current?.page.id,priorLocale=preferences.snapshot().locale;
 let preferenceTask=Promise.resolve();
 settingsPolicyChanged=false;
 settingsDialog=mountSettingsDialog({background:app,workspaceId,expectedAccountId:accountId,pageId,workspaceName:state.name,accountName:state.user.name,resource,initialSection:section,initialTeamspaceId:teamspaceId,labels:key=>t('settingsDialog.'+key),
  onPreferencesChanged:()=>{preferenceTask=preferenceTask.then(async()=>{
   if(state.user?.id!==accountId)return;
   preferences=new PreferencesStore({profileId:accountId});
   await Promise.all([i18n.switchLocale(preferences.snapshot().locale),fieldI18n.switchLocale(preferences.snapshot().locale)]);
   if(state.user?.id===accountId)applyPreferences();
  }).catch(()=>{state.error='preferenceFailed';});return preferenceTask;},
  onWorkspaceChanged:()=>{settingsPolicyChanged=true;},
  onClose:()=>{settingsDialog=null;const policyChanged=settingsPolicyChanged;settingsPolicyChanged=false;if(policyChanged)void refreshPolicyAfterSettings(accountId);autosave.refresh();presence.paint();if(room)void presence.publish(room,{force:true});
   void preferenceTask.then(()=>{if(state.user?.id===accountId&&preferences.snapshot().locale!==priorLocale){render();const link=app.querySelector('a[href^="/preferences.html"]');link?.focus({preventScroll:true});}});
  },
  onNavigateOut:href=>{void (async()=>{if(!await confirmReplace())return;autosave.stop();state.dirty=false;bodySaveBlocked='';location.assign(href);})();}
 });
 autosave.refresh();presence.paint();if(room)void presence.publish(room,{force:true});
}
modal.addEventListener('close',()=>{if(room?.phase==='review' && modal.dataset.view==='roomReviewTitle'){destroyRoom();render();}autosave.refresh();});
document.addEventListener('compositionend',()=>queueMicrotask(()=>{
 if(room?.renderAfterComposition && !roomCompositions.size){room.renderAfterComposition=false;render();}
 autosave.refresh();
}));
modal.addEventListener('toggle',presence.paint);
modal.addEventListener('cancel',event=> { if(state.busy || operation?.pending)event.preventDefault(); });
window.addEventListener('beforeunload', event => { if (state.dirty || state.busy || bodySaveTask || bodySaveBlocked) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide',()=>collectionView?.destroy());
window.addEventListener('keydown',event=> {
  if(modalOpen() || event.isComposing || event.keyCode===229 || !(event.ctrlKey || event.metaKey) || event.altKey || !(event.target?.closest('.inline-editor') || event.target?.id==='page-title'))return;
  if(event.key.toLowerCase()==='z' || event.key.toLowerCase()==='y') {if(applyEditorHistory(event.key.toLowerCase()==='y'||event.shiftKey?'redo':'undo'))event.preventDefault();}
});
window.addEventListener('keydown', event => { if (event.key === 'Escape' && state.navOpen && !modalOpen()) setNavigation(false); });
const mobileMedia = matchMedia('(max-width: 760px)');
mobileMedia.addEventListener('change', () => { state.navOpen = false; render(); });
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if(link&&!event.defaultPrevented&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){const section=settingsHrefSection(link.href,workspaceId);if(section&&state.user&&!state.fatal){event.preventDefault();openSettings(section);return;}}
  if (!link || link.getAttribute('href')?.startsWith('#') || !(state.dirty||bodySaveTask||bodySaveBlocked) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void confirmReplace().then(confirmed => { if (confirmed) { autosave.stop();state.dirty = false;bodySaveBlocked='';location.assign(link.href); } });
});
try {
  const initialLocale=preferences.snapshot().locale;
  const [catalogs,fieldCatalogs,instance]=await Promise.all([loadCatalogs({namespace:'workspace',locale:initialLocale}),loadCatalogs({namespace:'collections',locale:initialLocale}),loadInstanceConfig()]);
  instanceConfig=instance;workspaceBrand=createInstanceBrand(instance);applyInstanceDefaults(preferences,instance);
  i18n=createI18n(catalogs,initialLocale);fieldI18n=createI18n(fieldCatalogs,initialLocale);applyPreferences();
  if (!validId(workspaceId)) state.fatal = 'invalidWorkspace';
  else {
    const config = await request('/api/auth/config');
    if (!config?.enabled) state.fatal = 'disabled';
    else {
      const session = await request('/api/auth/get-session');
      if (!session?.user?.id) state.fatal = 'unauthorized';
      else {
        state.user = { id: session.user.id, name: session.user.name };
        preferences = new PreferencesStore({ profileId: state.user.id });applyInstanceDefaults(preferences,instanceConfig);
        await Promise.all([i18n.switchLocale(preferences.snapshot().locale),fieldI18n.switchLocale(preferences.snapshot().locale)]);applyPreferences();
        if (session.user.emailVerified !== true) state.fatal = 'unverified';
        else {
          const workspaces = await request('/api/auth/organization/list');
          const selected = Array.isArray(workspaces) ? workspaces.find(item => item.id === workspaceId) : null;
          if (selected) state.name = selected.name;
        }
      }
    }
  }
  render();
  if (!state.fatal) {
    await refreshList();
    const requestedPage = new URL(location.href).searchParams.get('page');
    if (validId(requestedPage) && state.pages.some(page => page.id === requestedPage)) await selectPage(requestedPage);
  }
} catch {
  if (i18n) { state.fatal = 'unavailable'; render(); }
  else app.replaceChildren(node('p', { class: 'startup', role: 'alert' }, '画面を読み込めませんでした。 / The workspace screen could not be loaded.'), node('a', { href: '/account.html' }, 'アカウント / Account'));
}

watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>workspaceBrand?.apply({kind})});
