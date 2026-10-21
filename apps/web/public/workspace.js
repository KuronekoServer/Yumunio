import {resolveAppearancePreferences,watchSystemAppearance} from './appearance.js';
import {createColumnResizeReview} from './column-resize-review.js';
import {createLayoutResize} from './layout-resize.js';
import {columnWidths,columnGridTemplate,resizeColumnBoundary,equalColumnWidths,validColumnWidths,validAttachmentLayout,validDatabasePresentation} from './block-layout.js';
import {loadInstanceConfig,validateInstanceConfig,applyInstanceDefaults,createInstanceBrand} from './instance.js';
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
import {PageReadPool,workspacePageTarget,matchingPageTitles} from './page-navigation.js';
import { validateSavedPage, pageBlocksEqual } from './page-save-result.js';
import { createBlockDnd } from './block-dnd.js';
import {createMentionPicker} from './mention-picker.js';
import {createWorkspacePresence} from './workspace-presence.js';
import {planBlockForestMove,createBlockColumnPlanner,arrangeBlockColumns} from './block-forest.js';
import {createPageBlockTransfer,validatePageBlockTransferResult} from './block-transfer.js';
import {mountSettingsDialog,settingsHrefSection} from './settings-dialog.js';
import {mountWorkspacePicker} from './workspace-picker.js';
import {sidebarPageRows,revealSidebarPage,sidebarSiblings,sidebarDropPlacement,readSidebarDisclosure,writeSidebarDisclosure} from './sidebar-model.js';
import {TeamspaceClient} from './teamspace-client.js';
import {validateCreatedPage,validateCreatedPageProjection} from './page-create-result.js';
import {createPageCreator,capturePageCreatorFocus,pageCreationDestinations} from './page-creator.js';
import {instantiatePageStarter} from './page-starters.js';
import {createSimpleTable,isSimpleTableData} from './simple-table.js';
import {createTableBlockView} from './table-block-view.js';
import {readClipboardContent} from './clipboard-content.js';
import {ClipboardUploadBatch} from './clipboard-upload.js';
import {isAttachmentBlock,createAttachmentBlock,renderAttachmentBlock} from './attachment-block.js';
import {pasteEditorBlocks,pasteInlineFragment} from './editor-tree.js';
import {duplicateEditorBlocks} from './editor-tree.js';
import {removeEditorBlocks,replaceEditorBlockSelection} from './editor-tree.js';
import {serializeEditorBlockClipboard,serializeEditorTextSelection,captureEditorTextSelection,readEditorBlockClipboard,writeEditorBlockClipboard} from './block-clipboard.js';
import {TEXT_BLOCK_TYPES,GENERATED_BLOCK_TYPES,isBookmarkBlock,isDatabaseBlock,isSyncedBlock,BLOCK_COLORS,validBlockIcon} from './block-types.js';
import {isComputedProperty,validateCollectionEnvelope} from './collections-model.js';
import {createTemplatePicker,createTemplateManager} from './collection-templates.js';
import {mountSyncedBlock} from './synced-block.js';
import {createRecordPanel} from './record-panel.js';
import {requestMotionSurface} from './motion-bridge.js';
import {captureBlockPositions} from './ui-motion-policy.js';
import {notifyContentChange} from './content-events.js';
import {connectContentStream} from './content-stream.js';
import {CoalescedReads} from './coalesced-reads.js';
import {prepareLivePagePatch} from './live-page-patch.js';
import {claimInitialWorkspaceReads} from './initial-workspace-reads.js';
import {bundledLocaleManifest,workspaceCatalogs,collectionsCatalogs} from './bundled-catalogs.js';
import {defaultDatabaseView,createDatabaseViewSettings,mountDatabasePlacement} from './database-placement.js';
import {renderOutline,renderBreadcrumb,renderBookmark,createBookmarkBlock} from './block-features.js';
import {renderEquation} from './equation-view.js';
import {defaultPageAppearance,validatePageAppearance} from './page-appearance.js';

export async function mountWorkspace({app,modal,renderChrome,updateToolbar,signal}) {
if(!app||!modal||typeof renderChrome!=='function'||typeof updateToolbar!=='function'||!signal)throw new TypeError('INVALID_WORKSPACE_HOST');
const mountedAt=performance.now();
const initialReads=claimInitialWorkspaceReads(location.href,signal);
if(initialReads){app.dataset.initialReadStartMs=String(Math.round(initialReads.startedAt));app.dataset.initialReadPrepared=String(initialReads.wasPrepared);}
const navigation=performance.getEntriesByType?.('navigation')[0],measureDocument=navigation?.name?.split('#')[0]===location.href.split('#')[0];
const listen=(target,type,handler,options={})=>target.addEventListener(type,handler,{...options,signal});
let stopAppearance=()=>{};
const workspaceId = new URL(location.href).searchParams.get('workspace') || '';
const detailMode=window.parent!==window&&new URL(location.href).searchParams.get('detail')==='1';
const detailTarget=new URL(location.href).searchParams;
document.documentElement.classList.toggle('detail-editor',detailMode);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const clone = value => structuredClone(value);
const supportedTypes = [...EDITABLE_BLOCK_TYPES,'heading1','heading2'];
const blockChoices=['paragraph','heading1','heading2','heading3','checklist','bulleted-list','numbered-list','quote','callout','toggle','divider','code','equation'];
const state = { user: null, name: '', role: '', pages: [], listRevision: 0, current: null, draft: null,
  collection: null, collectionError: '', recordError: '', people: [],
  dirty: false, busy: false, loading: false, listLoading: false, conflict: false, locked: false,
  fatal: '', notice: '', error: '', navOpen: false, selection: 0, listGeneration: 0, teamspaces: [], teamsAvailable:false, pendingPageId:null };
let workspaceBrand,instanceConfig;
let preferences = new PreferencesStore(), i18n, fieldI18n, pageController, sidebar, mainPanel, navButton;
let draggedPageId=null, operation=null, searchController, searchGeneration=0, searchQuery='', searchResults=null;
let exportController, editorHistory=null, restoringHistory=false, draggedBlockId=null;
const layoutControllers=new Set();let resizingLayout=false;
let blockDnd=null,blockDndGeneration=0;
let collectionView=null,collectionViewId=validId(new URL(location.href).searchParams.get('view'))?new URL(location.href).searchParams.get('view'):null,collectionRecovery=false,collectionRefresh=false;
const collectionActivities=new Set();
const databasePlacements=new Map();const syncedPlacements=new Map();let revisionRead=null;
const blockSelection={scope:null,mode:false,ids:new Set(),anchor:null};
let settingsDialog=null,workspacePicker=null,settingsPolicyChanged=false,policyRefresh=null;
const collapsedTeamspaces=new Set(),expandedSidebarPages=new Set();
let sidebarStorageScope=null;
function persistSidebarDisclosure(){if(sidebarStorageScope)try{writeSidebarDisclosure(localStorage,sidebarStorageScope,expandedSidebarPages,collapsedTeamspaces);}catch{}}
const collapsedToggles=new Set();
const modalOpen=()=>modal.open||settingsDialog?.open===true||workspacePicker?.open===true;
const policyRefreshActive=()=>policyRefresh?.accountId===state.user?.id&&policyRefresh?.selection===state.selection&&policyRefresh?.pageId===state.current?.page.id;
let room=null; const roomCompositions=new Set();
const presence=createWorkspacePresence({app,getRoom:()=>room,getCurrent:()=>state.current,isComposing:()=>roomCompositions.size>0,isModalOpen:modalOpen,translate:(...args)=>t(...args),onAuthorizationFailure:active=>stopRoomInput(active),signal});
let bodySaveTask=null, bodySaveBlocked='', draftGeneration=0, observedDraft='';
let contentStream=null,livePending=false,liveReading=false,liveTimer=null;
const concurrentReads=new CoalescedReads();
let initialPlacements=new Map(),initialSynced=new Map();
let placementUiStates=new Map();
const takeInitialRead=(map,id)=>{if(state.loading)return null;const value=map.get(id);map.delete(id);return value;};
let appearanceDraft=null,recordWriteActive=false,collectionReviewActive=false;
let pageIntent=0,navigationPreparation=null,prefetchTimer=null,editorDialogIntent=0;
const pagePositions=new Map();
const pageReads=new PageReadPool({scope:()=>state.user&&!state.fatal?JSON.stringify([state.user.id,workspaceId]):null,
 read:(id,options)=>request(basePath()+'/'+encodeURIComponent(id)+'?context=1',options),validate:validatePageEnvelope});
let clipboardUpload=null,clipboardStarting=false;
const autosaveModalBlocked=()=>modalOpen()&&!(modal.open&&modal.dataset.view==='pageTools.appearance'&&!settingsDialog?.open&&!workspacePicker?.open);
const autosave=new PageAutosave({
  getState:()=>{
    const propertyDraft=state.collection?.dirty===true;
    const cannotWrite=!canEdit()&&!propertyDraft&&!appearanceDraft;
    return {
      scopeKey:state.current&&state.user?JSON.stringify([state.user.id,workspaceId,state.current.page.id,state.selection]):null,
      generation:draftGeneration,
      dirty:draftPending(),
      paused:cannotWrite||state.busy||!!clipboardUpload||state.loading||state.listLoading||
        !!room&&!propertyDraft||autosaveModalBlocked()||roomCompositions.size>0||
        state.conflict||!!bodySaveBlocked||!!draggedBlockId||resizingLayout||collectionActivities.size>0||!!detailPanel.state()
    };
  },
  save:context=>persistDraft(context),onState:()=>refreshSaveStatus()
});
const t = (key, values) => i18n ? i18n.t(key, values) : key;
const fieldT = (key, values) => fieldI18n ? fieldI18n.t(key, values) : key;
const detailPanel=createRecordPanel({workspaceId,getAccountId:()=>state.user?.id,t,signal,
 prepare:async()=>{if(state.busy||state.loading||modalOpen()||roomCompositions.size||clipboardUpload||clipboardStarting)return false;await autosave.flush();await settleBodySave();if(room&&!await settleRoom())return false;return !draftPending()&&!state.conflict&&!bodySaveBlocked;},
 onChanged:()=>{void syncCurrentRevision();for(const view of databasePlacements.values())void view.refresh();for(const view of syncedPlacements.values())void view.refresh();if(collectionView&&!state.collection?.dirty)void collectionView.refresh();},
  onClosed:async()=>{await syncCurrentRevision();autosave.refresh();scheduleLiveRefresh();}
});
function detailStatus(){if(detailMode)window.parent.postMessage({type:'yumunio:detail-ready',workspaceId,accountId:state.user?.id,pageId:state.current?.page.id,dirty:bodyDirty()||draftPending()||room?.client?.pending===true,busy:state.busy||state.loading||!!bodySaveTask||!!clipboardUpload,revision:state.current?.revision},location.origin);}
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
function canEdit() { return !!state.current?.page.capabilities?.includes('editBody') && !state.current?.page.appearance?.locked && !state.locked && !(room?.phase==='ready' && room.client?.editable===false); }
function editingDisabled() { return !canEdit() || state.busy || !!clipboardUpload || state.loading || !!room && room.phase!=='ready'; }
function structureDisabled() { return editingDisabled() || !!room&&room.client?.protocol!==2 || roomCompositions.size > 0; }
function bodyDirty() {
  if (!state.current || !state.draft) return false;
  return state.draft.title !== state.current.page.title || !pageBlocksEqual(state.draft.blocks,state.current.document.blocks);
}
function draftPending(){
  if(!state.current)return false;
  return !room&&bodyDirty()||state.collection?.dirty===true||appearanceDraft!==null;
}
function draftSignature(){return JSON.stringify([state.draft,[...(state.collection?.drafts??[])],appearanceDraft]);}
function updateDirty(historyGroup=null) {
  if(editorHistory && state.draft && !restoringHistory && !room) {try {editorHistory.record(state.draft,{group:historyGroup,selection:editorSelection() || editorHistory.current.selection});}catch {editorHistory=null;state.error='historyUnavailable';}}
  state.dirty = bodyDirty() || draftPending() || room?.client?.pending === true;
  const signature=draftSignature();
  if(signature!==observedDraft){observedDraft=signature;draftGeneration++;autosave.notify();}else autosave.refresh();
  refreshSaveStatus();
  refreshRoomStatus();
  if(room?.client?.pending||room?.needsSync)queueRoomSync(room);
}
function refreshSaveStatus() {
  if(signal.aborted)return;
  detailStatus();
  const roomStatus=roomStatusKey();
  const quietRoom=['roomSynced','roomPending','roomSyncing','roomWaitingInput'].includes(roomStatus);
  let status='';
  if(state.loading||policyRefreshActive())status=t('loading');
  else if(state.current){
    if(bodySaveBlocked==='unknown')status=t('saveUnknownStatus');
    else if(state.conflict)status=t('saveConflictStatus');
    else if(bodySaveBlocked)status=t('savePaused');
    else if(state.recordError)status=t('recordInvalidValue');
    else if(room&&!quietRoom)status=t(roomStatus);
    else if(!room&&!canEdit())status=t('readOnly');
  }
  updateToolbar({status,title:state.draft?.title||state.pages.find(page=>page.id===state.pendingPageId)?.title||t('untitled'),
    undoDisabled:structureDisabled()||!(room?room.client?.canUndo:editorHistory?.canUndo),
    redoDisabled:structureDisabled()||!(room?room.client?.canRedo:editorHistory?.canRedo)});
}
async function settleBodySave(){if(bodySaveTask)await bodySaveTask;return !state.conflict&&!bodySaveBlocked&&!state.locked;}
function refreshPageFeedback(){
  const host=app.querySelector('[data-page-feedback]');if(!host)return;
  host.replaceChildren();
  if(policyRefreshActive())return;
  if(state.conflict||bodySaveBlocked){host.append(node('div',{class:'conflict-note',role:'alert'},[
    node('strong',{},t(state.conflict?'conflictTitle':'savePaused')),
    node('p',{},t(bodySaveBlocked==='unknown'?'saveUnknown':state.conflict?'conflict':state.error||'saveFailed')),
    button('reload',()=>void reloadPage(),{disabled:state.busy||state.loading||!!bodySaveTask})
  ]));}
  else if(state.error||state.notice)host.append(node('p',{class:'message'+(state.error?' is-error':''),role:state.error?'alert':'status'},t(state.error||state.notice,state.noticeValues)));
  if(clipboardUpload){const batch=clipboardUpload.batch;host.append(node('div',{class:'clipboard-progress',role:'status'},[
    node('p',{},t(batch.state==='paused'?'clipboard.paused':'clipboard.uploading',{number:Math.min(batch.index+1,batch.files.length),total:batch.files.length})),
    ...(batch.state==='paused'?[button('clipboard.retry',()=>void runClipboardUpload(),{disabled:state.busy}),button('clipboard.cancel',()=>void cancelClipboardUpload(),{disabled:state.busy})]:[])
  ]));}
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
const lifetimeSignal=signal;
async function request(path,options={}){
 const{method='GET',body,signal}=options;
 if(method==='GET'||method==='POST'&&path.endsWith('/query'))return concurrentReads.run(JSON.stringify([state.user?.id,path,method,body,options.headers]),()=>requestRaw(path,{...options,signal:undefined}),{signal});
 concurrentReads.clear();initialPlacements.clear();initialSynced.clear();return requestRaw(path,options);
}
async function requestRaw(path, { method = 'GET', body, signal, headers: extraHeaders = {} } = {}) {
  if(method!=='GET'&&!path.endsWith('/query'))pageReads.clear();
  const timeout = AbortSignal.timeout(15000);
  let response;
  try {
    response = await ((!state.user?.id&&method==='GET'&&!Object.keys(extraHeaders).length?initialReads?.take(path,{signal:lifetimeSignal}):null)??fetch(path, { method, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([...(signal?[signal]:[]),timeout,lifetimeSignal]),
      headers: { ...(state.user?.id ? { 'X-Yumunio-Expected-Account': state.user.id } : method === 'GET' ? {} : { 'X-Yumunio-Expected-Account': '' }), ...extraHeaders, ...(body === undefined || body instanceof Uint8Array ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }) }));
  } catch (error) { if (signal?.aborted) throw error; throw new ApiError(0, 'NETWORK_FAILED'); }
  lifetimeSignal.throwIfAborted();
  let data; try { data = await response.json(); } catch { throw new ApiError(0, 'INVALID_RESPONSE'); }
  if (!response.ok) { if([401,403,404].includes(response.status))pageReads.clear(); throw new ApiError(response.status, data?.error?.code); }
  if(method!=='GET'&&!path.endsWith('/query')&&/\/collections(?:\/|$)|\/pages(?:\/[A-Za-z0-9._:-]+)?$/.test(path))notifyContentChange({workspaceId,accountId:state.user?.id,revision:data.revision});
  return data;
}
function roomStatusKey() {
 if(!room)return 'roomOff';
 if(room.phase==='opening')return 'roomOpening';
 if(room.phase==='review')return 'roomReviewRequired';
 if(room.phase==='syncing')return 'roomSyncing';
 if(room.phase==='paused')return 'roomPaused';
 if(room.phase==='stopped')return 'roomStopped';
 if(room.phase==='ready'&&!room.transport?.ready&&!room.syncError)return 'roomOpening';
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
 if(room)refreshSaveStatus();
 if(room && ['ready','paused'].includes(room.phase))for(const control of app.querySelectorAll('.room-controls button'))control.disabled=state.busy || room.client?.busy || room.renewing || room.syncing;
}
function destroyRoom() {if(!room)return;presence.leave(room);clearTimeout(room.timer);clearTimeout(room.flushTimer);room.transport?.close();room.client?.destroy();room=null;roomCompositions.clear();}
function stopRoomInput(active) {
 if(room!==active)return;
 presence.leave(active);active.phase='stopped';active.client?.stop();clearTimeout(active.timer);clearTimeout(active.flushTimer);active.transport?.close();state.notice='roomInputStopped';
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
function queueRoomSync(active,delay=60){
 if(room!==active||active.phase!=='ready')return;active.needsSync=true;
 if(active.flushTimer||active.syncing||active.renewing||!active.transport?.ready||document.hidden||modalOpen()||state.busy||state.loading||state.listLoading||roomCompositions.size)return;
 active.flushTimer=setTimeout(()=>{active.flushTimer=null;if(room===active&&active.phase==='ready')void syncRoom(false);},delay);
}
async function connectRoomSocket(active){
 active.client.request=call=>active.transport?active.transport.request(call):Promise.reject(new ApiError(0,'ROOM_SOCKET_CLOSED'));
 const {RoomSocketTransport}=await import('./shared/collaboration-client.js');if(room!==active||active.phase!=='ready')return;
 const url=new URL(active.client.path+'/ws',location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
 active.transport=new RoomSocketTransport({url:url.href,headers:()=>active.client.requestHeaders({'X-Yumunio-Room-Ticket':active.client.ticket}),
  onReady:()=>{if(room!==active)return;active.syncError=false;queueRoomSync(active,0);void presence.publish(active,{force:true});refreshRoomStatus();},
  onChange:kind=>{if(room!==active)return;if(kind==='content')queueRoomSync(active,0);else void presence.publish(active,{readOnly:true});},
  onDisconnect:({permanent})=>{if(room!==active||active.phase!=='ready')return;if(permanent)stopRoomInput(active);else{active.syncError=true;refreshRoomStatus();void verifyRoomAfterDisconnect(active);}}
 });await active.transport.connect().catch(()=>{if(room===active){active.syncError=true;refreshRoomStatus();}});
}
async function verifyRoomAfterDisconnect(active){
 try{const value=await request(active.client.path,{headers:active.client.requestHeaders({'X-Yumunio-Room-Ticket':active.client.ticket})});if(room===active&&(value.epoch!==active.client.epoch||value.editable!==active.client.editable))stopRoomInput(active);}
 catch(error){if(room===active&&([401,403,404].includes(error.status)||['ROOM_EPOCH_CHANGED','ROOM_PROTOCOL_UNSUPPORTED'].includes(error.code)))stopRoomInput(active);}
}
function scheduleRoomHeartbeat() {
 if(!room)return;clearTimeout(room.timer);const active=room;
 if(active.phase!=='ready')return;
 active.timer=setTimeout(async()=> {
  if(room!==active || active.phase!=='ready')return;
  if(!document.hidden && !state.loading && !active.client.busy && active.client.ticketRenewalDue())await renewRoom(active);
  if(room!==active || active.phase!=='ready')return;
  if(active.needsSync||active.client.pending)queueRoomSync(active);
  if(room===active){await presence.publish(active);scheduleRoomHeartbeat();}
 },10000);
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
async function settleRoom(){
 const active=room,deadline=Date.now()+15000;if(!active)return true;
 while(room===active&&active.phase==='ready'&&Date.now()<deadline){
  if(state.busy||roomCompositions.size||modalOpen()||!state.draft?.title.trim())return false;
  if(active.client.busy||active.syncing||active.renewing){await new Promise(resolve=>setTimeout(resolve,40));continue;}
  await syncRoom(false);if(room!==active)return false;if(active.syncError||active.deferred)return false;
  if(!active.client.pending&&!active.client.busy&&!active.syncing)return true;
  await new Promise(resolve=>setTimeout(resolve,40));
 }return false;
}
function refreshRoomAttachments(active){
 if(room!==active||active.assetRead||!state.current)return;const missing=()=>[...indexEditorBlocks(state.draft.blocks).values()].some(({block})=>isAttachmentBlock(block)&&!state.current.attachments?.some(asset=>asset.id===block.data.links[0].attachmentId));if(!missing())return;
 const scope=blockDragScope();active.assetRead=request(basePath()+'/'+encodeURIComponent(state.current.page.id)).then(value=>{if(room!==active||scope!==blockDragScope())return;const fresh=validatePageEnvelope(value,state.current.page.id);state.current.attachments=fresh.attachments??[];active.base.attachments=state.current.attachments;for(const {block}of indexEditorBlocks(state.draft.blocks).values())if(isAttachmentBlock(block)){const row=document.getElementById('block-'+block.id),previous=row?.querySelector('.attachment-block');if(previous)previous.replaceWith(renderResizableAttachment(block));}}).catch(error=>{if(room===active&&[401,403,404].includes(error.status))stopRoomInput(active);}).finally(()=>{active.assetRead=null;});
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
function activateRoom(active) {if(room!==active)return;active.phase='ready';applyRoomDraft(active,active.client.snapshot());scheduleRoomHeartbeat();void connectRoomSocket(active);}
async function showRoomStart() {
 if(!state.current||room||state.busy||!await prepareEditorDialog())return;
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
 if(room!==active || active.phase!=='ready' || modalOpen() || state.busy || state.loading || roomCompositions.size || draggedBlockId || resizingLayout || wideBlockSelection())return null;
 const before=indexEditorBlocks(state.draft.blocks),after=indexEditorBlocks(draft.blocks);
 let structural=before.size!==after.size;
 for(const[id,old]of before){const next=after.get(id);if(!next || old.block.type!==next.block.type || old.parentId!==next.parentId || old.index!==next.index || Object.hasOwn(old.block,'children')!==Object.hasOwn(next.block,'children')||old.block.type==='table'&&JSON.stringify(old.block.data)!==JSON.stringify(next.block.data))structural=true;}
 if(structural&&active.client.protocol!==2)return null;
 const checks=structural?[]:prepareRoomCheckboxPatch(app,before,after);if(!checks)return null;
 const title=document.getElementById('page-title');if(!title || title.value!==state.draft.title)return null;
 const patches=[],layoutChanges=[];
 if(!structural)for(const[id,old]of before){const next=after.get(id).block,key=old.block.type==='columns'?'widths':isAttachmentBlock(old.block)?'layout':isDatabaseBlock(old.block)?'presentation':null;if(key&&JSON.stringify(old.block.data?.[key])!==JSON.stringify(next.data?.[key]))layoutChanges.push(id);}
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
 else if(focused?.classList.contains('simple-table-cell')&&focused.dataset.pageId===state.current?.page.id){try{key=active.client.tableCellKey({blockId:focused.dataset.blockId,row:Number(focused.dataset.tableRow),column:Number(focused.dataset.tableColumn)});selection={start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection||'none'};}catch{return null;}}
 else if(focused?.classList.contains('inline-editor') && focused.dataset.pageId===state.current?.page.id) {
  key='block:'+focused.dataset.blockId;selection=captureInlineSelection(focused);
  const range=document.getSelection();if(selection){const end=range?.rangeCount?range.getRangeAt(0):null;selection.direction=end&&!range.isCollapsed&&range.anchorNode===end.endContainer&&range.anchorOffset===end.endOffset?'backward':'forward';}
 }
 const marker=key&&selection?active.client.captureRelativeSelection({key,...selection}):null;
 if(key&&!marker)return null;
 const scroll=app.querySelector('.workspace-scroll');
 return {draft:JSON.stringify(draft),structural,before,after,checks,patches,layoutChanges,title,focused,marker,key,scroll,scrollTop:scroll?.scrollTop,scrollLeft:scroll?.scrollLeft,fieldTop:focused?.scrollTop,fieldLeft:focused?.scrollLeft};
}
function applyRoomInPlace(active,draft,plan) {
 if(room!==active || !plan || plan.draft!==JSON.stringify(draft) || roomCompositions.size)throw new ApiError(0,'INVALID_ROOM_DOM');
 if(plan.structural){
  const selection=plan.marker?active.client.resolveRelativeSelection(plan.marker):null;
  state.draft=clone(draft);state.current=roomEnvelope(active.base,draft,active.client);active.base=state.current;state.conflict=false;
  const page=state.pages.find(item=>item.id===state.current.page.id);if(page){page.title=draft.title;page.version=active.client.documentVersion;}
  render();const scroll=app.querySelector('.workspace-scroll');if(scroll){scroll.scrollTop=plan.scrollTop;scroll.scrollLeft=plan.scrollLeft;}
  if(selection?.key==='title'){const title=document.getElementById('page-title');title?.focus({preventScroll:true});title?.setSelectionRange(selection.start,selection.end,selection.direction);}
  else if(selection?.key.startsWith('cell/')){const cell=active.client.tableCellPosition(selection.key);if(cell)requestAnimationFrame(()=>focusTableCell({...cell,start:selection.start,end:selection.end}));}
  else if(selection){const id=selection.key.slice(6);if(blockLocation(id))focusBlock(id,selection.start,selection.end);else{const fallback=[...plan.before.keys()].find(key=>plan.after.has(key)&&typeof plan.after.get(key).block.data?.text==='string');if(fallback)focusBlock(fallback);else focusContent();}}
  return;
 }
 if(!applyRoomCheckboxPatch(plan.checks))throw new ApiError(0,'INVALID_ROOM_DOM');
 for(const {input,snapshot,expectedText}of plan.patches)if(!patchInlineEditor(input,snapshot,{expectedText}).applied)throw new ApiError(0,'INVALID_ROOM_DOM');
 plan.title.value=draft.title;autoSize(plan.title);
 // Existing input callbacks close over these block objects. Preserve that graph.
 state.draft.title=draft.title;
 for(const[id,location]of plan.before){const data=plan.after.get(id).block.data;if(data===undefined)delete location.block.data;else location.block.data=clone(data);}
 for(const id of plan.layoutChanges)paintBlockLayout(plan.before.get(id).block);
 state.current=roomEnvelope(active.base,state.draft,active.client);active.base=state.current;
 const page=state.pages.find(item=>item.id===state.current.page.id);if(page){page.title=draft.title;page.version=active.client.documentVersion;}
 for(const {blockId}of plan.patches){const row=[...app.querySelectorAll('.block-row')].find(item=>item.dataset.blockId===blockId);if(row)refreshBlockLinks(row,plan.before.get(blockId).block);}
 const crumb=app.querySelector('.breadcrumb span:last-child');if(crumb)crumb.textContent=draft.title||t('untitled');
 const selected=app.querySelector('.page-link.selected [data-sidebar-page-title]');if(selected)selected.textContent=draft.title||t('untitled');
 const version=app.querySelector('[data-document-version]');if(version)version.textContent=t('version',{version:active.client.documentVersion});
 workspaceBrand?.apply({kind:document.documentElement.style.colorScheme,titleSuffix:'',pageTitle:draft.title||t('untitled')});
 if(plan.focused===document.activeElement && plan.marker) {
  const selection=active.client.resolveRelativeSelection(plan.marker);
  if(selection?.key==='title')plan.title.setSelectionRange(selection.start,selection.end,selection.direction);
  else if(selection?.key.startsWith('cell/'))plan.focused.setSelectionRange(selection.start,selection.end,selection.direction);
  else if(selection)setInlineSelection(plan.focused,{...selection,direction:selection.direction==='none'?'forward':selection.direction,focus:false,scroll:false});
 }
 if(plan.scroll){plan.scroll.scrollTop=plan.scrollTop;plan.scroll.scrollLeft=plan.scrollLeft;}
 if(plan.focused && Number.isFinite(plan.fieldTop)){plan.focused.scrollTop=plan.fieldTop;plan.focused.scrollLeft=plan.fieldLeft;}
 state.conflict=false;updateDirty();presence.refresh();
}
async function syncRoom(manual=true,stopAfter=false) {
 const active=room;if(!active?.client || !['ready','paused'].includes(active.phase) || state.busy || recordWriteActive || roomCompositions.size)return;
 if(active.renewPromise)await active.renewPromise;
 if(room!==active || !['ready','paused'].includes(active.phase) || active.client.busy || state.busy || recordWriteActive || roomCompositions.size)return;
 if(!state.draft.title.trim()){if(manual){state.error='titleRequired';render();}return;}
 if(active.phase==='paused'){active.phase='ready';render();}
 clearTimeout(active.timer);clearTimeout(active.flushTimer);active.flushTimer=null;active.needsSync=false;active.syncing=true;active.syncError=false;active.deferred=false;refreshRoomStatus();
 try {
  let prepared=null;
  const result=await active.client.sync({
   canApply:({draft})=>{prepared=prepareRoomApply(active,draft);return!!prepared;},
   onApply:({draft})=>{applyRoomInPlace(active,draft,prepared);prepared=null;refreshRoomAttachments(active);}
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
  if(room===active){refreshRoomStatus();scheduleRoomHeartbeat();if(active.needsSync||active.client.pending||active.deferred)queueRoomSync(active,active.deferred?500:60);}
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
  button('cancel',()=>modal.close()),button('roomKeepAndStop',()=>{presence.leave(active);active.client?.stop();active.phase='stopped';clearTimeout(active.timer);clearTimeout(active.flushTimer);active.transport?.close();modal.close();render();}),
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
 if(!room)return document.createDocumentFragment();
 const controls=[];
 if(room.phase==='ready' || room.phase==='paused')controls.push(button(room.phase==='paused'?'roomRetry':'roomSync',()=>void syncRoom(),{disabled:state.busy}),button('roomStop',stopRoom,{disabled:state.busy}));
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
  try { validateInlineBlockMetadata(data.document.blocks);if(data.page.appearance)validatePageAppearance(data.page.appearance); } catch { throw new ApiError(0,'INVALID_RESPONSE'); }
  return data;
}
function showModal(title, content, { cancelLabel = 'close',motionKind } = {}) {
  blockDnd?.cancel();
  collectionView?.cancel();
  modal.dataset.view=title; modal.className=title==='createPage'?'page-create-dialog':['searchPages','trashPages','exportWorkspace'].includes(title)?'wide-dialog':'';
  if (modal.open) {if(modal.closeImmediately)modal.closeImmediately();else modal.close();}
  modal.dataset.motionKind=motionKind??(['pageActions','blockType','blockSelection.actions','addBlock'].includes(title)?'menu':'modal');
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
/** Finish normal edits before a dialog pauses autosave or changes the workspace revision. */
async function prepareEditorDialog(){
  const intent=++editorDialogIntent,scope=collectionScope();
  await closeModalFully();
  await autosave.flush();
  await settleBodySave();
  return !signal.aborted&&intent===editorDialogIntent&&scope===collectionScope();
}
async function confirmReplace(reload = false) {
  if(detailPanel.state()&&!await detailPanel.close())return false;
  if(collectionActivities.size||clipboardUpload||clipboardStarting)return false;
  await settleBodySave();
  if(!reload&&!modalOpen()&&!bodySaveBlocked&&!state.conflict){await autosave.flush();updateDirty();}
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
  state.navOpen = open; paintChrome();
  if (navButton) navButton.setAttribute('aria-expanded', String(open));
  const mobile = matchMedia('(max-width: 760px)').matches;
  if (mainPanel) mainPanel.inert = open && mobile;
  if (sidebar) sidebar.inert = !open && mobile;
  if (open) sidebar?.querySelector('button,a')?.focus({preventScroll:true}); else navButton?.focus({preventScroll:true});
}
function autoSize(input) { input.style.height = 'auto'; input.style.height = Math.max(40, input.scrollHeight) + 'px'; }
function afterModalExit(action){if(modal.open&&modal.inert){modal.addEventListener('close',action,{once:true});return true;}return false;}
function focusContent() {if(afterModalExit(focusContent))return;document.getElementById('page-title')?.focus({preventScroll:true});}
function restoreSidebarDisclosure(){
 if(state.user?.id){const key='yumunio.sidebar.v1:'+workspaceId+':'+state.user.id;if(key!==sidebarStorageScope){sidebarStorageScope=key;expandedSidebarPages.clear();collapsedTeamspaces.clear();let saved;try{saved=readSidebarDisclosure(localStorage,key);}catch{}if(saved){for(const id of saved.expanded)expandedSidebarPages.add(id);for(const id of saved.collapsedTeams)collapsedTeamspaces.add(id);}}}
}
function paintChrome(){
 if(signal.aborted)return null;
 restoreSidebarDisclosure();
 const activeTeams=state.teamspaces.filter(team=>team.role!==null&&!team.archivedAt);
 const mounted=renderChrome({workspaceId,t,room:!!room,selectionMode:blockSelection.mode,state:{...state,current:state.current?{...state.current,page:{...state.current.page}}:null,draft:state.draft?{title:state.draft.title}:null},
  activeTeams,pageRows:sidebarPageRows(state.pages,expandedSidebarPages),collapsedTeams:[...collapsedTeamspaces],expandedPages:[...expandedSidebarPages],
  newDisabled:!!room||!state.user||!!state.fatal||state.role==='guest'||state.busy||state.listLoading||state.locked,
  handlers:{openWorkspacePicker,setNavigation,openSearch,openWorkspaceHome,openSettings,refreshList,openCreate,createSubpage,moveSidebarPage,openSidebarPageMove,openSidebarPageTrash,openSidebarTeamspaceMove,openCreateTeamspace,selectPage,prefetchPage,cancelPagePrefetch,startPageDrag,endPageDrag,overPageDrop,dropPage,openTrash,openExport,applyEditorHistory,openResourceSharing,openPageActions,reloadPage,showRoomStart,
   toggleFavorite:()=>{if(state.current)void runPageTool('favorite',{favorite:!state.current.page.favorite});},
   toggleTeam:id=>{if(collapsedTeamspaces.has(id))collapsedTeamspaces.delete(id);else collapsedTeamspaces.add(id);persistSidebarDisclosure();paintChrome();},
   togglePage:id=>{if(expandedSidebarPages.has(id))expandedSidebarPages.delete(id);else expandedSidebarPages.add(id);persistSidebarDisclosure();paintChrome();}}});
 if(mounted){sidebar=mounted.sidebar;mainPanel=mounted.mainPanel;navButton=mounted.navButton;}
 return mounted;
}
function retainPlacements(controllers){
 const scope=collectionScope();
 for(const[id,controller]of controllers)if(!scope||state.loading||controller.scope!==scope||!controller.matchesBlock(blockLocation(id)?.block)){controller.destroy();controllers.delete(id);}
}
function releaseHiddenPlacements(){
 for(const controllers of [databasePlacements,syncedPlacements])for(const[id,controller]of controllers)if(!controller.root.isConnected){controller.destroy();controllers.delete(id);}
}
async function placementsReady(){
 await Promise.resolve();
 await Promise.allSettled([collectionView?.ready,...[...databasePlacements.values(),...syncedPlacements.values()].map(controller=>controller.ready)]);
}
function render() {
  if(signal.aborted)return;
  queueMicrotask(presence.refresh);
  collectionView?.destroy();collectionView=null;
   retainPlacements(databasePlacements);retainPlacements(syncedPlacements);
  const dndGeneration=++blockDndGeneration;
  for(const controller of layoutControllers)controller.destroy();layoutControllers.clear();resizingLayout=false;
  blockDnd?.destroy();blockDnd=null;draggedBlockId=null;syncBlockSelection();
  const active = document.activeElement;
  const inlineSelection = active?.classList?.contains('inline-editor') && active.dataset.pageId === state.current?.page.id ? captureInlineSelection(active) : null;
  const inlineBlockId = inlineSelection ? active.dataset.blockId : null;
  const tableSelection=active?.classList?.contains('simple-table-cell')&&active.dataset.pageId===state.current?.page.id?editorSelection():null;
   const mounted=paintChrome();if(!mounted){for(const controllers of [databasePlacements,syncedPlacements]){for(const controller of controllers.values())controller.destroy();controllers.clear();}return;}
  const workspaceName=state.name||t('serverWorkspace');
  const newDisabled=!!room||!state.user||!!state.fatal||state.role==='guest'||state.busy||state.listLoading||state.locked;
  const scroll=mounted.scroll;
  const content = node('section', { class: 'document-content' + (state.collection && !state.current?.page.recordId ? ' has-collection' : ''), id: 'workspace-document', tabindex: '-1', 'aria-label': t('currentPage') });
  const appearance=state.current?.page.appearance??defaultPageAppearance();
  content.classList.toggle('full-width',appearance.fullWidth);content.classList.toggle('small-text',appearance.smallText);
  if (state.fatal) {
    content.append(node('div', { class: 'empty-state' }, [icon('page'), node('h1', {}, t('title')), node('p', { role: 'status' }, t(state.fatal)),
      node('a', { class: 'button primary', href: '/account' }, t('openAccount'))]));
  } else if (state.loading&&!state.current) {
    const page=state.pages.find(page=>page.id===state.pendingPageId);
    content.append(node('h1',{class:'page-loading-title',translate:'no'},page?.title||t('loading')),node('div',{class:'page-skeleton','aria-label':t('loading'),role:'status'},[node('span',{}),node('span',{}),node('span',{})]));
  } else if (!state.current) {
    content.append(node('p', { class: 'boundary-note' }, t('boundary')), node('div', { class: 'empty-state' }, [
      icon('page'), node('h1', {}, t(state.listLoading ? 'loading' : state.pages.length ? 'selectPage' : 'emptyTitle')),
      node('p', {}, t(state.role === 'guest' ? 'emptyGuest' : 'emptyIntro')),
      ...(state.role !== 'guest' ? [button('createPage', () => void openCreate(), { primary: true, icon: 'plus', disabled: !!newDisabled })] : [])
    ]));
  } else {
    if(room)content.append(renderRoomPanel());content.append(node('div',{'data-page-feedback':''}));
    const cover=state.current.attachments?.find(asset=>asset.id===appearance.coverAttachmentId);
    if(cover)content.append(node('img',{class:'page-cover',src:attachmentPath(cover.id)+'/preview',alt:'',loading:'lazy'}));
    if(appearance.icon)content.append(node('div',{class:'page-icon',translate:'no','aria-hidden':'true'},appearance.icon));
    if(appearance.locked)content.append(node('p',{class:'page-lock-note'},[t('pageTools.locked'),...(state.current.page.capabilities.includes('editBody')?[button('pageTools.unlock',()=>void runPageTool('appearance',{appearance:{...appearance,locked:false}}),{disabled:!!room||state.busy})]:[])]));
    const title = node('textarea', { id: 'page-title', class: 'page-title', rows: '1', maxlength: '240', 'aria-label': t('pageTitle'), value: state.draft.title, disabled: editingDisabled(), onBeforeInput:rememberEditorSelection,
      onInput: event => { state.draft.title = event.target.value.replace(/[\r\n]/g, ' '); if (event.target.value !== state.draft.title) event.target.value = state.draft.title; autoSize(event.target); recordRoomText('title',state.draft.title); updateDirty('title'); } });
    title.addEventListener('compositionstart',()=>{roomCompositions.add('title');updateDirty();});title.addEventListener('compositionend',()=>{roomCompositions.delete('title');updateDirty();});
    const metadata=node('div', { class: 'document-meta' }, [
      node('span', {}, t(room && room.phase!=='ready' ? 'readOnly' : canEdit() ? 'editAllowed' : 'readOnly')),
      node('span', {'data-document-version':''}, t('version', { version: state.current.document.version })),
      ...(room?[node('span', {}, t(['paused','stopped'].includes(room.phase)?'roomStoppedSync':'roomLimitedSync'))]:[])
    ]);
    content.append(title);
    if(!canEdit())content.append(metadata);
    if (state.current.attachments?.length) content.append(renderPageAttachments());
    content.append(node('nav',{class:'child-page-directory','data-child-pages':'','aria-label':t('pageTree.children')}));
    refreshChildPages(content);
    if (state.collection) content.append(renderCollection());
    if (state.collectionError) content.append(node('p',{class:'message',role:'status'},t(state.collectionError)));
    if(canEdit()&&(!room||room.client?.protocol===2))content.append(node('details',{class:'document-tools',...(blockSelection.mode?{open:true}:{})},[node('summary',{},t('editorOptions')),metadata,renderBlockSelectionToolbar()]));
    else if(canEdit())content.append(metadata);
    const blocks = node('div', { class: 'document-blocks' });
    const locations=indexEditorBlocks(state.draft.blocks),nestingPlanner=createEditorNestingPlanner(state.draft.blocks);
    state.draft.blocks.forEach(block => blocks.append(renderBlock(block, locations,nestingPlanner)));
    const last=state.draft.blocks.at(-1);
    if(!structureDisabled()&&!(last?.type==='paragraph'&&last.data?.text===''&&!last.children?.length))blocks.append(renderBodyEntry());
    const endDrop=node('div',{class:'block-end-drop'},t('dropBlockAtEnd'));blocks.append(endDrop);content.append(blocks);
    if (canEdit()) content.append(button('addBlock', () => openBlockPicker(), { icon: 'plus',iconOnly:true,label:t('addBlock'), class: 'add-block icon-button', disabled: structureDisabled(), title:room?t('roomStopFirst'):t('addBlock') }));
    content.append(node('details',{class:'workspace-editor-help'},[
      node('summary',{},t('editorHelp')),
      ...(room?[node('p',{class:'draft-note'},t('roomDraftHint'))]:[]),
      node('p',{class:'draft-note'},t(room?'inline.roomDisabled':'inline.hint')),
      ...(!room?[node('p',{class:'draft-note'},t('mention.editorHint'))]:[]),
      ...(!room?[node('p',{class:'draft-note'},t('nesting.keyboardHint')),node('p',{class:'draft-note'},t('blockMove.hint'))]:[])
    ]));
  }
  if (!state.current && !state.fatal && (state.error || state.notice)) content.prepend(node('p', { class: 'message', role: state.error ? 'alert' : 'status' }, t(state.error || state.notice, state.noticeValues)));
  content.setAttribute('aria-busy',String(state.loading));
  content.dataset.pageId=state.current?.page.id||state.pendingPageId||'';
  scroll.replaceChildren(content);
   releaseHiddenPlacements();
  blockDnd=createBlockDnd({root:app,canStart:blockId=>dndGeneration===blockDndGeneration&&canDragBlock(blockId),getScope:blockDragScope,getBlocks:()=>state.draft?.blocks||[],getBlockIds:dragSelectionIds,allowColumns:!room||room.client?.supportsFeature('block-layout'),allowMultiPageTransfer:true,canDropOnPage:({blockId,blockIds,pageId})=>dndGeneration===blockDndGeneration&&validBlockPageDrop(pageId)&&canTransferSelection(blockId,blockIds),
    onCommit:operation=>dndGeneration===blockDndGeneration&&commitBlockDrag(operation),onCrossPage:({blockId,blockIds,pageId})=>{if(dndGeneration!==blockDndGeneration||!canDragBlock(blockId)||!validBlockPageDrop(pageId)||!canTransferSelection(blockId,blockIds))return false;void openBlockMove(blockId,pageId,blockIds);return true;},
    onActiveChange:(active,blockId)=>{if(dndGeneration!==blockDndGeneration)return;if(active)requestMotionSurface('cancel-placement',{});if(active&&blockSelection.mode&&!blockCoveredBySelection(blockId)){blockSelection.ids=new Set([blockId]);blockSelection.anchor=blockId;refreshBlockSelectionUi();}draggedBlockId=active?blockId:null;autosave.refresh();},labels:(key,values)=>t('blockDnd.'+key,values)});
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
 if(blockSelection.mode){const tools=app.querySelector('.document-tools');if(tools)tools.open=true;}
 for(const input of app.querySelectorAll('[data-block-select-id]')){input.hidden=!blockSelection.mode;input.checked=blockSelection.ids.has(input.dataset.blockSelectId);input.disabled=structureDisabled()||!canEditNestedBlock(locations.get(input.dataset.blockSelectId));}
 for(const row of app.querySelectorAll('.block-row[data-block-id]')){const location=locations.get(row.dataset.blockId);row.classList.toggle('is-block-selected',blockSelection.mode&&(selected.has(row.dataset.blockId)||!!location?.ancestors.some(parent=>selected.has(parent.id))));}
 const status=app.querySelector('[data-block-selection-count]');if(status)status.textContent=t('blockSelection.count',{count});
 for(const control of app.querySelectorAll('[data-block-selection-active]'))control.hidden=!blockSelection.mode;
 const toggle=app.querySelector('[data-block-selection-toggle]');if(toggle){toggle.textContent=t(blockSelection.mode?'blockSelection.done':'blockSelection.start');toggle.setAttribute('aria-pressed',String(blockSelection.mode));toggle.disabled=structureDisabled();}
 const move=app.querySelector('[data-block-selection-move]');if(move)move.disabled=!count||structureDisabled()||state.conflict||!!bodySaveBlocked;
 const transfer=app.querySelector('[data-block-selection-transfer]');if(transfer)transfer.disabled=!count||structureDisabled()||state.conflict||!!bodySaveBlocked||!canTransferSelection(roots[0],roots);
 const clear=app.querySelector('[data-block-selection-clear]');if(clear)clear.disabled=!blockSelection.ids.size||structureDisabled();
 for(const control of app.querySelectorAll('[data-block-selection-edit]'))control.disabled=!count||!!room||structureDisabled()||state.conflict||!!bodySaveBlocked;
}
function renderBlockSelectionToolbar() {
 const toolbar=node('div',{class:'block-selection-toolbar','aria-label':t('blockSelection.title')});
 const toggle=button('blockSelection.start',()=>setBlockSelectionMode(!blockSelection.mode),{class:'quiet',disabled:structureDisabled()});toggle.setAttribute('data-block-selection-toggle','');
 const count=node('span',{'data-block-selection-count':'','data-block-selection-active':'',role:'status','aria-live':'polite'});
 const move=button('blockSelection.move',openSelectedBlockMove,{disabled:true});move.setAttribute('data-block-selection-move','');move.setAttribute('data-block-selection-active','');
 const transfer=button('moveBlockToPage',()=>void openBlockMove(selectedBlockRoots()[0]),{disabled:true});transfer.setAttribute('data-block-selection-transfer','');transfer.setAttribute('data-block-selection-active','');
 const clear=button('blockSelection.clear',()=>{blockDnd?.cancel();blockSelection.ids.clear();blockSelection.anchor=null;refreshBlockSelectionUi();},{disabled:true});clear.setAttribute('data-block-selection-clear','');clear.setAttribute('data-block-selection-active','');
 const edits=[['clipboard.copy',()=>void copySelectedBlocks()],['clipboard.cut',()=>void copySelectedBlocks({cut:true})],['blocks.duplicate',()=>duplicateBlocks(selectedBlockRoots())],['clipboard.delete',deleteSelectedBlocks]].map(([label,action])=>{const control=button(label,action,{disabled:true});control.setAttribute('data-block-selection-active','');control.setAttribute('data-block-selection-edit','');return control;});
 toolbar.append(toggle,count,...edits,move,transfer,clear,button('columns.addTwo',()=>addColumns(2),{disabled:!!room||structureDisabled()||state.conflict||!!bodySaveBlocked}),button('columns.addThree',()=>addColumns(3),{disabled:!!room||structureDisabled()||state.conflict||!!bodySaveBlocked}),node('span',{'data-block-selection-active':'',class:'block-selection-hint'},t('blockSelection.keyboardHint')));return toolbar;
}
const clipboardContext=()=>({origin:location.origin,workspaceId,pageId:state.current?.page.id,accountId:state.user?.id});
const blockClipboardEnabled=()=>!structureDisabled()&&(!room||room.client?.supportsFeature('content-blocks'))&&!state.conflict&&!bodySaveBlocked&&!modalOpen()&&!clipboardStarting;
function clearBlockSelection(){blockSelection.mode=false;blockSelection.ids.clear();blockSelection.anchor=null;}
function deleteSelectedBlocks(){
 if(!blockClipboardEnabled())return;const ids=selectedBlockRoots();if(!ids.length)return;
 rememberEditorSelection();const result=removeEditorBlocks(state.draft.blocks,ids);clearBlockSelection();finishTreeChange(result);
}
async function copySelectedBlocks({cut=false,data}={}){
 if(!blockClipboardEnabled())return false;const ids=selectedBlockRoots();if(!ids.length)return false;
 const scope=blockDragScope(),basis=JSON.stringify(state.draft.blocks);
 try{
  const value=serializeEditorBlockClipboard(state.draft.blocks,ids,clipboardContext());
  if(data)writeEditorBlockClipboard(data,value);
  else await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([value.text],{type:'text/plain'}),'text/html':new Blob([value.html],{type:'text/html'})})]);
  if(scope!==blockDragScope()||basis!==JSON.stringify(state.draft.blocks)||!blockClipboardEnabled())return false;
  if(cut){rememberEditorSelection();const result=removeEditorBlocks(state.draft.blocks,ids);clearBlockSelection();finishTreeChange(result);}
  state.notice=cut?'clipboard.cutDone':'clipboard.copied';state.error='';refreshPageFeedback();return true;
 }catch(error){state.error=error?.message==='BLOCK_CLIPBOARD_UNSUPPORTED'?'clipboard.unsupported':'clipboard.copyFailed';refreshPageFeedback();return false;}
}
function pasteSelectedBlocks(data){
 if(!blockSelection.mode||!selectedBlockRoots().length)return false;
 if(!blockClipboardEnabled())return true;
 try{
  let inserted=readEditorBlockClipboard(data,clipboardContext(),{allowAttachmentTransfer:true});
  if(!inserted){const content=readClipboardContent(data,{document});if(content.kind==='files')return false;if(content.kind==='text'&&content.text.length>MAX_INLINE_TEXT)throw new TypeError('CLIPBOARD_DOCUMENT_TOO_LARGE');inserted=content.kind==='table'?[{id:crypto.randomUUID(),type:'table',data:content.table}]:content.kind==='blocks'?content.blocks:[{id:crypto.randomUUID(),type:'paragraph',data:{text:content.text}}];}
  const roots=selectedBlockRoots(),apply=blocks=>{const result=replaceEditorBlockSelection(state.draft.blocks,roots,blocks);rememberEditorSelection();clearBlockSelection();finishTreeChange(result);};
  if(clipboardAttachmentSources(inserted).size)void transferClipboardAttachments(inserted,apply);else apply(inserted);
 }catch(error){state.error=error?.message==='BLOCK_CLIPBOARD_ATTACHMENT_PAGE'?'clipboard.attachmentPage':clipboardError(error);refreshPageFeedback();}
 return true;
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
  onClipboard:(data,selection)=>handleEditorClipboard(data,selection,{parentId,index:parentId===null?state.draft.blocks.length:blockLocation(parentId).block.children.length}),
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
 if(room){if(structureDisabled())throw new TypeError('ROOM_OPERATION_UNSUPPORTED');let draft;try{if(room.client.supportsFeature('content-blocks')&&!result.roomBlockIds){const clean=clone(result.blocks);for(const {block}of indexEditorBlocks(clean).values())if(!blockLocation(block.id)){if(block.data?.links?.some(link=>!link.attachmentId)){block.data.links=block.data.links.filter(link=>link.attachmentId);state.notice='clipboard.referenceText';}if(block.data?.mentions?.some(mention=>mention.kind!=='date')){block.data.mentions=block.data.mentions.filter(mention=>mention.kind==='date');state.notice='clipboard.referenceText';}}draft=room.client.pasteTree(clean);}else{const prepared=prepareRoomTreeOperation(state.draft.blocks,result.blocks,{blockIds:result.roomBlockIds});draft=room.client.operation(prepared.operation,prepared);}}catch(error){if(['ROOM_CAPACITY','ROOM_TOO_LARGE'].includes(error?.code))stopRoomInput(room);throw error;}state.draft=clone(draft);presence.changed();}
 else state.draft.blocks=result.blocks;updateDirty();render();
 if(result.focusHandle){const focusHandle=()=>requestAnimationFrame(()=>[...app.querySelectorAll('[data-block-drag-handle]')].find(handle=>handle.closest('[data-block-id]')?.dataset.blockId===result.focusHandle)?.focus({preventScroll:true}));if(!afterModalExit(focusHandle))focusHandle();return;}
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
 if(block.children?.length)branch.append(node('div',{class:'nested-block-list'+(depth>=MAX_EDITOR_NESTING-1?' depth-capped':''),hidden:block.type==='toggle'&&collapsedToggles.has(block.id),role:'group','aria-label':t('nesting.children',{number})},block.children.map(child=>renderBlock(child,locations,nestingPlanner))));
 return branch;
}
function columnsTargetText(location) {
 if(location.block.type==='columns')return t('columns.group',{count:location.block.children?.length||0});
 if(location.block.type==='column')return t('columns.column',{number:location.index+1});
 if(isDatabaseBlock(location.block))return location.block.data.presentation?.title?.trim()||databasePlacements.get(location.block.id)?.envelope?.collection.title||t('inlineDatabase.title');
 return location.block.data?.purpose==='import-source'?t('importSource'):location.block.data?.text||t(supportedTypes.includes(location.block.type)?location.block.type:'unsupported');
}
function columnsAt(parentId) {
 const parent=parentId?blockLocation(parentId):null;
 return !parent||![parent.block,...parent.ancestors].some(block=>['columns','column'].includes(block.type));
}
function layoutEnabled(blockId,scope=blockDragScope()){
 return scope===blockDragScope()&&!structureDisabled()&&!state.conflict&&!bodySaveBlocked&&!modalOpen()&&!draggedBlockId&&!wideBlockSelection()&&(!room||room.client?.supportsFeature('block-layout'))&&canEditNestedBlock(blockLocation(blockId));
}
/** Update metadata in place so current text editors, DB scroll positions and selections survive. */
function applyBlockLayout(blockId,key,value,operation){
 const location=blockLocation(blockId);if(!location||structureDisabled()||state.conflict||bodySaveBlocked||room&&!room.client?.supportsFeature('block-layout'))return false;
 try{
  if(key==='widths'?!validColumnWidths(value,location.block.children?.length):key==='layout'?!validAttachmentLayout(value):!validDatabasePresentation(value))throw new TypeError('BLOCK_COLUMNS_STRUCTURE');
  if(JSON.stringify(key==='widths'?columnWidths(location.block):location.block.data?.[key])===JSON.stringify(value))return true;
  rememberEditorSelection();
  if(room){const draft=room.client.operation(operation),next=blockLocation(blockId,draft.blocks)?.block;if(!next)throw new TypeError('ROOM_OPERATION_UNSUPPORTED');location.block.data={...location.block.data,[key]:clone(next.data[key])};presence.changed();}
  else{
   if(!editorHistory)throw new TypeError('EDITOR_HISTORY_UNAVAILABLE');
   const candidate=clone(state.draft);blockLocation(blockId,candidate.blocks).block.data={...location.block.data,[key]:clone(value)};
   const probe=new EditorHistory(state.draft,{maxSteps:editorHistory.maxSteps,maxBytes:editorHistory.maxBytes}),selection=editorHistory.current.selection;probe.record(state.draft,{selection});probe.record(candidate,{selection});if(!probe.canUndo)throw new TypeError('EDITOR_HISTORY_TOO_LARGE');
   location.block.data={...location.block.data,[key]:clone(value)};
  }
  paintBlockLayout(location.block);updateDirty();return true;
 }catch(error){state.error=nestingError(error);refreshPageFeedback();return false;}
}
function layoutActivity(active){resizingLayout=active;app.classList.toggle('layout-resizing',active);autosave.refresh();if(!active&&room?.needsSync)queueRoomSync(room,0);}
function paintBlockLayout(block){
 if(block.type==='columns'){const grid=[...app.querySelectorAll('.block-columns-group')].find(element=>element.dataset.branchId===block.id)?.querySelector('.columns-grid');if(grid)paintColumnWidths(grid,columnWidths(block));}
 else if(isDatabaseBlock(block))databasePlacements.get(block.id)?.updatePresentation();
 else if(isAttachmentBlock(block)){const figure=document.getElementById('block-'+block.id)?.querySelector('.attachment-block'),value=block.data.layout??{width:100,align:'left'};if(figure){figure.style.setProperty('--attachment-width',value.width+'%');figure.dataset.align=value.align;const handle=figure.querySelector('.attachment-resize-handle');handle?.setAttribute('aria-valuenow',String(value.width));handle?.setAttribute('aria-valuetext',value.width+'%');}}
}
function paintColumnWidths(grid,widths){
 grid.style.setProperty('--column-tracks',columnGridTemplate(widths));
 for(const handle of grid.querySelectorAll('[data-column-divider]')){const index=Number(handle.dataset.columnDivider);handle.setAttribute('aria-valuemin','15');handle.setAttribute('aria-valuemax',String((widths[index]+widths[index+1])/10-15));handle.setAttribute('aria-valuenow',String(widths[index]/10));handle.setAttribute('aria-valuetext',t('layout.columnValue',{left:widths[index]/10,right:widths[index+1]/10}));}
}
function columnWidthControls(groupId){
 const block=blockLocation(groupId)?.block,scope=blockDragScope(),widths=columnWidths(block),root=node('div',{class:'column-width-controls'}),fields=widths.map((width,index)=>node('input',{type:'number',min:15,max:85,step:'.1',value:width/10,'aria-label':t('layout.columnPercent',{number:index+1})})),feedback=node('p',{class:'hint',role:'status'});
 fields.forEach((input,index)=>root.append(node('label',{class:'field'},[t('layout.columnPercent',{number:index+1}),input])));
 const apply=button('layout.applyWidths',()=>{const current=blockLocation(groupId)?.block,next=fields.map(input=>Number(input.value)*10).map(Math.round);if(scope!==blockDragScope()||current!==block||!validColumnWidths(next,block.children.length)){feedback.textContent=t('layout.widthTotal');return;}if(applyBlockLayout(groupId,'widths',next,{kind:'column-widths',blockId:groupId,columnIds:block.children.map(column=>column.id),widths:next})){const grid=[...app.querySelectorAll('.block-columns-group')].find(element=>element.dataset.branchId===groupId)?.querySelector('.columns-grid');if(grid)paintColumnWidths(grid,next);modal.close();}},{disabled:!!room&&!room.client?.supportsFeature('block-layout')});
 const equal=button('layout.equalWidths',()=>{equalColumnWidths(block.children.length).forEach((value,index)=>fields[index].value=value/10);});
 root.append(node('p',{class:'hint'},t('layout.resizeHint')),feedback,node('div',{class:'dialog-actions'},[equal,apply]));return root;
}
function renderResizableAttachment(block){
 const figure=renderAttachmentBlock(block,{document,pageId:state.current.page.id,attachments:state.current.attachments??[],path:attachmentPath,unavailable:t('clipboard.unavailable'),imageError:t('clipboard.imageError')}),scope=blockDragScope();
 if(!layoutEnabled(block.id)||!figure.querySelector('img,iframe,video'))return figure;
 const read=()=>clone(blockLocation(block.id)?.block.data.layout??{width:100,align:'left'}),handle=node('button',{type:'button',class:'attachment-resize-handle',role:'slider','aria-orientation':'horizontal','aria-label':t('layout.resizeAttachment'),'aria-valuemin':15,'aria-valuemax':100,title:t('layout.resizeAttachmentHint')});
 figure.append(handle);
 layoutControllers.add(createLayoutResize({handle,read,canStart:()=>layoutEnabled(block.id,scope),onStart:rememberEditorSelection,onActive:layoutActivity,
  project:({initial,phase,x,geometry,key,shift})=>{if(phase==='start'){const width=figure.parentElement?.getBoundingClientRect().width;return width>0?{width,x,scale:initial.align==='center'?2:1,direction:initial.align==='right'?-1:1}:null;}let delta=phase==='move'?(x-geometry.x)/geometry.width*100*geometry.scale*geometry.direction:(key==='ArrowLeft'?-1:key==='ArrowRight'?1:0)*(shift?5:1);return{...initial,width:Math.max(15,Math.min(100,Math.round(key==='Home'?15:key==='End'?100:initial.width+delta)))};},
  preview:value=>{figure.style.setProperty('--attachment-width',value.width+'%');figure.dataset.align=value.align;handle.setAttribute('aria-valuenow',String(value.width));handle.setAttribute('aria-valuetext',value.width+'%');},commit:value=>applyBlockLayout(block.id,'layout',value,{kind:'attachment-layout',blockId:block.id,layout:value}),reset:initial=>({...initial,width:100})}));return figure;
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
 showModal('columns.actions',[columnWidthControls(groupId),node('p',{class:'hint'},t('columns.unwrapHint')),node('div',{class:'block-action-list'},[
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
 paintColumnWidths(grid,columnWidths(block));
 for(const [columnIndex,column] of block.children.entries()){
  const columnLocation=locations.get(column.id),columnMutable=canEditEditorParent(columnLocation),label=t('columns.column',{number:columnLocation.index+1});
  const cell=node('div',{class:'column-cell','data-column-id':column.id,role:'group','aria-label':label});
  const target=node('div',{class:'block-row block-column'+(column.children.length?'':' is-empty-column'),'data-block-id':column.id,tabindex:'-1','aria-label':label},[
   node('span',{},label),button('columns.addBlock',()=>openBlockPicker(null,{parentId:column.id,index:column.children.length}),{icon:'plus',iconOnly:true,label:t('columns.addBlock'),class:'quiet icon-button',disabled:structureDisabled()||!columnMutable})
  ]);
  const body=node('div',{class:'column-blocks'},column.children.map(child=>renderBlock(child,locations,nestingPlanner)));
  const last=column.children.at(-1);
  if(!structureDisabled()&&columnMutable&&!(last?.type==='paragraph'&&last.data?.text===''&&!last.children?.length))body.append(renderBodyEntry({parentId:column.id}));
  cell.append(target,body);grid.append(cell);
  if(columnIndex<block.children.length-1&&!disabled&&(!room||room.client?.supportsFeature('block-layout'))){
   const scope=blockDragScope(),columnIds=block.children.map(item=>item.id),read=()=>columnWidths(blockLocation(block.id)?.block??block),handle=node('button',{type:'button',class:'column-resize-handle',role:'separator','aria-orientation':'vertical','aria-label':t('layout.resizeColumns',{left:columnIndex+1,right:columnIndex+2}),'data-column-divider':columnIndex,title:t('layout.resizeHint')});cell.append(handle);
   layoutControllers.add(createLayoutResize({handle,read,canStart:()=>layoutEnabled(block.id,scope)&&JSON.stringify(blockLocation(block.id)?.block.children.map(item=>item.id))===JSON.stringify(columnIds)&&!matchMedia('(max-width:760px)').matches,onStart:rememberEditorSelection,onActive:layoutActivity,
    project:({initial,phase,x,geometry,key,shift})=>{const direction=getComputedStyle(grid).direction==='rtl'?-1:1;if(phase==='start'){const width=grid.getBoundingClientRect().width-parseFloat(getComputedStyle(grid).columnGap)*(initial.length-1);return width>0?{width,x,direction}:null;}const delta=phase==='move'?(x-geometry.x)/geometry.width*1000*geometry.direction:key==='Home'?-1000:key==='End'?1000:(key==='ArrowLeft'?-1:1)*(shift?50:10)*direction;return resizeColumnBoundary(initial,columnIndex,delta);},
    preview:value=>paintColumnWidths(grid,value),commit:value=>applyBlockLayout(block.id,'widths',value,{kind:'column-widths',blockId:block.id,columnIds,widths:value}),reset:()=>equalColumnWidths(block.children.length)}));
  }
 }
 branch.append(row,grid);return branch;
}
function renderBlockRow(block,location,locations,nestingPlanner) {
 const type=block.type,index=location.index,number=location.order+1,attachmentBlock=isAttachmentBlock(block),mutable=canEditNestedBlock(location)&&(!room||room.client?.supportsFeature('content-blocks')||TEXT_BLOCK_TYPES.includes(type)||type==='divider');
 const sourceText=importSourceText(block);
 if(sourceText!==null){
  const code=node('pre',{class:'unsupported-block',tabindex:'0',translate:'no'},node('code',{},sourceText));
  const part=Number.isSafeInteger(block.data.sourcePart)&&Number.isSafeInteger(block.data.sourceParts)&&block.data.sourcePart>0&&block.data.sourceParts>=block.data.sourcePart?t('importSourcePart',{part:block.data.sourcePart,total:block.data.sourceParts}):t('importSource');
  return node('details',{class:'import-source-reference'},[node('summary',{},part),code]);
 }
 const simpleTable=type==='table'&&isSimpleTableData(block.data),database=isDatabaseBlock(block),synced=isSyncedBlock(block),generated=GENERATED_BLOCK_TYPES.includes(type),bookmark=isBookmarkBlock(block),supported=supportedTypes.includes(type),row=node('div',{class:'block-row block-'+(supported||simpleTable||database||synced||attachmentBlock||generated||bookmark?type:'unsupported')+(type==='heading'?' level-'+Math.max(1,Math.min(3,block.data?.level||1)):'' )});
 row.dataset.blockId=block.id;
 row.id='block-'+block.id;
 if(BLOCK_COLORS.includes(block.data?.color))row.dataset.color=block.data.color;
 if(BLOCK_COLORS.includes(block.data?.background))row.dataset.background=block.data.background;
 row.append(node('div',{class:'inline-actions'},[
  button('insertBlockHere',()=>openBlockPicker(null,{parentId:location.parentId,index}),{icon:'plus',iconOnly:true,label:t('insertBlockHere'),class:'block-handle inline-add icon-button',disabled:structureDisabled()||!mutable}),
  button('blockActions',()=>openBlockActions(block.id),{icon:'grip',iconOnly:true,label:t('blockActions',{number}),class:'block-handle icon-button',disabled:structureDisabled()||!mutable})
 ]));
 const grip=row.querySelector('.inline-actions button:last-child');
 grip.setAttribute('data-block-drag-handle','');grip.setAttribute('aria-describedby','block-dnd-instructions');
 grip.title=t('blockDnd.handle');
 const select=node('input',{type:'checkbox',class:'block-select',hidden:!blockSelection.mode,'data-block-select-id':block.id,'aria-label':t('blockSelection.select',{number}),checked:blockSelection.ids.has(block.id),disabled:structureDisabled()||!mutable,onClick:event=>toggleBlockSelection(block.id,event.currentTarget.checked,event.shiftKey)});
 row.querySelector('.inline-actions').prepend(select);
 if(type==='table-of-contents'){row.append(renderOutline(state.draft.blocks,{document,label:t('blocks.tableOfContents'),empty:t('blocks.noHeadings')}));return row;}
 if(type==='breadcrumb'){row.append(renderBreadcrumb(state.pages,state.current.page.id,{document,href:id=>'/workspace?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(id),label:t('blocks.breadcrumb')}));return row;}
 if(bookmark){row.append(renderBookmark(block,document));return row;}
 if(synced){const retained=syncedPlacements.get(block.id);if(retained){row.append(retained.root);const seed=takeInitialRead(initialSynced,block.id);if(seed)queueMicrotask(()=>void retained.refresh(seed));return row;}const host=node('section',{'aria-label':t('synced.label')}),scope=collectionScope();row.append(host);queueMicrotask(()=>{if(!host.isConnected||scope!==collectionScope())return;const controller=mountSyncedBlock({root:host,block,workspaceId,request,initialRead:takeInitialRead(initialSynced,block.id),isCurrent:()=>scope===collectionScope(),canDetach:()=>!structureDisabled()&&structureAllowed(block.id),onEdit:envelope=>void openRecordDetail({pageId:envelope.page.id,title:envelope.page.title},null),onDetach:()=>void detachSyncedBlock(block.id),onRemove:()=>void removeSyncedPlacement(block.id),onRevision:revision=>syncCurrentRevision(revision),onAccessLost:()=>{if(detailPanel.state()?.pageId===block.data.pageId)detailPanel.destroy();},t,signal});controller.scope=scope;syncedPlacements.set(block.id,controller);});return row;}
 if(database){const retained=databasePlacements.get(block.id);if(retained){row.append(retained.root);retained.updatePresentation();const seed=takeInitialRead(initialPlacements,block.id);if(seed)queueMicrotask(()=>void retained.refresh(false,seed));return row;}const host=node('section',{class:'database-placement','aria-label':t('inlineDatabase.title')}),scope=collectionScope();row.append(host);queueMicrotask(()=>{if(host.isConnected&&scope===collectionScope()){const controller=mountDatabasePlacement({root:host,initialRead:takeInitialRead(initialPlacements,block.id),initialState:takeInitialRead(placementUiStates,block.id),getBlock:()=>blockLocation(block.id)?.block,workspaceId,request,isCurrent:()=>scope===collectionScope(),canConfigure:()=>!room&&!structureDisabled(),t,fieldT,onConfigure:envelope=>void openDatabaseSettings(block.id,envelope),onChangeView:(view,revision)=>changeInlineDatabaseView(block.id,view,revision),onActions:envelope=>openDatabaseActions(block.id,envelope),onNewRecord:envelope=>void createInlineRecord(envelope),onOpenRecord:openRecordDetail,onRevision:revision=>syncCurrentRevision(revision),onAccessLost:()=>{if(detailPanel.state()?.collectionId===block.data.collectionId)detailPanel.destroy();},signal});controller.scope=scope;databasePlacements.set(block.id,controller);}});return row;}
 if(type==='toggle'){const toggle=node('button',{type:'button',class:'toggle-disclosure','aria-label':t('blocks.toggleChildren'),'aria-expanded':String(!collapsedToggles.has(block.id)),onClick:()=>{if(collapsedToggles.has(block.id))collapsedToggles.delete(block.id);else collapsedToggles.add(block.id);render();}},collapsedToggles.has(block.id)?'▸':'▾');row.append(toggle);}
 if(type==='callout')row.append(node('span',{class:'callout-icon','aria-hidden':'true'},block.data?.icon||'💡'));
 if(simpleTable){
  const scope=blockDragScope(),enabled=()=>scope===blockDragScope()&&row.isConnected&&(!room||room.client?.supportsFeature('content-blocks'))&&!editingDisabled()&&!state.conflict&&!bodySaveBlocked&&!modalOpen()&&!draggedBlockId&&canEditNestedBlock(blockLocation(block.id));
  const view=createTableBlockView({document,data:block.data,blockId:block.id,pageId:state.current.page.id,getData:()=>blockLocation(block.id)?.block.data,readOnly:!mutable||!!room&&!room.client?.supportsFeature('content-blocks'),canEdit:enabled,labels:(key,values)=>t('simpleTable.'+key,values),onBeforeChange:rememberEditorSelection,
   onChange:(data,change)=>{if(!enabled())return;if(room){const next=room.client.setTable({blockId:block.id,data,change});blockLocation(block.id).block.data=clone(blockLocation(block.id,next.blocks).block.data);presence.changed();}else blockLocation(block.id).block.data=data;updateDirty(change.kind==='text'?'table-cell-'+block.id+'-'+change.row+'-'+change.column:null);},
   onComposition:(active,key)=>{const marker='table:'+block.id+':'+key;if(active)roomCompositions.add(marker);else roomCompositions.delete(marker);autosave.refresh();},onHistory:applyEditorHistory,
   onError:error=>{state.error=error.message==='SIMPLE_TABLE_TOO_LARGE'?'simpleTable.limit':error.message==='CLIPBOARD_FILES_IN_CELL'?'clipboard.filesInCell':'simpleTable.error';refreshPageFeedback();},confirmDelete:({axis,index})=>window.confirm(t(axis==='row'?'simpleTable.confirmDeleteRow':'simpleTable.confirmDeleteColumn',{number:index+1}))});
  row.append(view.element);if(room&&!room.client?.supportsFeature('content-blocks'))row.append(node('p',{class:'block-note'},t('simpleTable.roomReadOnly')));return row;
 }
 if(attachmentBlock){row.append(node('div',{class:'attachment-size-container'},renderResizableAttachment(block)));return row;}
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
  const input=createInlineEditor({text,maxTextLength:type==='equation'?10000:MAX_INLINE_TEXT,marks:block.data?.marks||[],links:readableLinks(block.data),mentions:block.data?.mentions||[],pageHref:pageReferenceHref,preserveInsertedFormatting:!room||room.client?.protocol===2,formatEnabled:(!room||room.client?.protocol===2)&&!['code','equation'].includes(type),className:'block-input',readOnly:editingDisabled()||!mutable||!!room&&typeof block.data?.text!=='string',
   onClipboard:(data,selection)=>handleEditorClipboard(data,selection,['code','equation'].includes(type)?{parentId:location.parentId,index:location.index+1}:{blockId:block.id},{tables:!['code','equation'].includes(type),rich:!['code','equation'].includes(type)}),
   placeholder:t(type==='paragraph'?'placeholder':type),label:t('blockText',{number}),
   onChange:(value,change)=>{block.data=editableBlockData(block.data,value,change.marks,change.links,change.mentions);if(change.kind==='text')recordRoomText('block:'+block.id,value,change);else if(room&&change.kind==='format'){try{room.client.setMarks({blockId:block.id,...change.range,marks:change.marks});presence.changed();}catch{stopRoomInput(room);}}updateDirty(['format','reference','mention'].includes(change.kind)?null:'text-'+block.id);refreshBlockLinks(row,block);if(type==='equation')row.querySelector('.equation-preview')?.replaceWith(renderEquation(value,document));},
   onBeforeFormat:rememberEditorSelection,onFormatError:()=>{state.error='inline.error';render();},onLimit:()=>{state.error='textTooLong';render();},
   onSlash:['code','equation'].includes(type)||room?undefined:()=>openBlockPicker(block.id),onHistory:direction=>applyEditorHistory(direction),
   onIndent:['code','equation'].includes(type)?undefined:(direction,selection)=>changeBlockNesting(block.id,direction,{blockId:block.id,...selection},{keyboard:true}),
   onStructureError:()=>{state.error='nesting.singleBlock';render();},
   onShortcut:prefix=>{if(room||!structureAllowed(block.id)||block.type!=='paragraph'||block.children?.length)return false;const conversion=markdownPrefix(prefix);if(!conversion)return false;rememberEditorSelection();block.data=editableBlockData(block.data,prefix);updateDirty('text-'+block.id);block.type=conversion.type;block.data=conversion.data;let focusId=block.id;if(block.type==='divider'){const next={id:crypto.randomUUID(),type:'paragraph',data:{text:''}};const current=blockLocation(block.id);state.draft.blocks=insertEditorBlock(state.draft.blocks,{block:next,parentId:current.parentId,index:current.index+1});focusId=next.id;}updateDirty();render();focusBlock(focusId);return true;},
   onSplit:['code','equation'].includes(type)||room&&!room.client?.supportsFeature('block-transforms')?undefined:selection=>{if(!transformCurrent()||!structureAllowed(block.id))return;rememberEditorSelection();try{if(room){finishRoomTransform(prepareRoomSplitOperation(state.draft.blocks,{blockId:block.id,start:selection.start,end:selection.end,newBlockId:crypto.randomUUID()}));return;}finishTreeChange(splitEditorBlock(state.draft.blocks,{blockId:block.id,start:selection.start,end:selection.end,newId:crypto.randomUUID()}));}catch(error){state.error=nestingError(error);render();}},
   onMerge:['code','equation'].includes(type)||room&&!room.client?.supportsFeature('block-transforms')?undefined:()=>{if(!transformCurrent()||!structureAllowed(block.id))return true;rememberEditorSelection();try{if(room)return finishRoomTransform(prepareRoomMergeOperation(state.draft.blocks,block.id));const result=mergeEditorBlock(state.draft.blocks,block.id);if(!result.changed)return false;finishTreeChange(result);return true;}catch(error){state.error=nestingError(error);render();return true;}},
   onNavigate:direction=>{const eligible=[...locations.values()].filter(value=>canEditNestedBlock(value)&&!['divider','image','file'].includes(value.block.type)&&value.block.data?.purpose!=='import-source'),position=eligible.findIndex(value=>value.block.id===block.id),target=eligible[position+direction]?.block;if(!target)return false;focusBlock(target.id,direction<0?(target.data?.text||'').length:0);return true;}
  });
  input.dataset.blockId=block.id;input.dataset.pageId=state.current.page.id;
  input.addEventListener('beforeinput',rememberEditorSelection);input.addEventListener('compositionstart',()=>{roomCompositions.add(block.id);updateDirty();});input.addEventListener('compositionend',()=>{roomCompositions.delete(block.id);updateDirty();});
  const surface=node('div',{class:'inline-edit-surface'},input),formatToolbar=createInlineToolbar(input,{labels:inlineFormattingLabels(t),...(!room&&!['code','equation'].includes(type)?{pageReferences:{load:loadPageReferenceCandidates,href:pageReferenceHref}}:{})});if(formatToolbar)surface.append(formatToolbar);if(!room&&!['code','equation'].includes(type)&&mutable&&!editingDisabled())surface.append(createPageMentionPicker(input));
  row.append(surface);if(type==='equation')row.append(renderEquation(text,document));refreshBlockLinks(row,block);
  if(!mutable)row.append(node('p',{class:'block-note'},t(location.depth>=MAX_EDITOR_NESTING?'nesting.legacyDepth':'nesting.readOnly')));
 }else row.append(node('div',{class:'unsupported-block'},[node('p',{},t('unsupported')),...(text?[node('p',{translate:'no'},text)]:[])]));
 return row;
}
function attachmentPath(attachmentId) { return basePath()+'/'+encodeURIComponent(state.current.page.id)+'/attachments/'+encodeURIComponent(attachmentId); }

function clipboardError(error){
 if(error?.message==='SIMPLE_TABLE_TOO_LARGE')return 'simpleTable.limit';
 if(error?.message==='CLIPBOARD_DOCUMENT_TOO_LARGE')return 'clipboard.pageLimit';
 if(error?.message==='CLIPBOARD_FILES_TOO_LARGE')return 'clipboard.fileLimit';
 if(error?.status===413)return 'clipboard.storageLimit';
 if(error?.code==='ATTACHMENTS_DISABLED')return 'clipboard.disabled';
 if(error?.status===409)return 'clipboard.changed';
 if([401,403,404].includes(error?.status))return 'clipboard.accessChanged';
 return error?.message==='INVALID_CLIPBOARD_TABLE'?'clipboard.invalidTable':'clipboard.failed';
}
function handleEditorClipboard(data,selection,target,options={}){
 try{
  const internal=readEditorBlockClipboard(data,clipboardContext(),{allowAttachmentTransfer:true});
  if(internal){if(options.rich===false)return false;if(!blockClipboardEnabled())return true;const insertion={...target,...(target.blockId?{start:selection?.start??0,end:selection?.end??selection?.start??0}:{})},apply=blocks=>{rememberEditorSelection();finishTreeChange(pasteEditorBlocks(state.draft.blocks,{...insertion,inserted:blocks}));};if(clipboardAttachmentSources(internal).size)void transferClipboardAttachments(internal,apply);else apply(internal);return true;}
  const content=readClipboardContent(data,{document,...options});if(content.kind==='text')return false;
  if(clipboardStarting||editingDisabled()||state.conflict||bodySaveBlocked||modalOpen()||roomCompositions.size)return true;
  if(room&&!room.client?.supportsFeature('content-blocks')){state.error='roomStopFirst';refreshPageFeedback();return true;}
  if(wideBlockSelection()){state.error='nesting.singleBlock';refreshPageFeedback();return true;}
  const insertion={...target,...(target.blockId?{start:selection?.start??0,end:selection?.end??selection?.start??0}:{})};
  rememberEditorSelection();
  if(content.kind==='table')finishTreeChange(pasteEditorBlocks(state.draft.blocks,{...insertion,inserted:[{id:crypto.randomUUID(),type:'table',data:content.table}]}));
  else if(content.kind==='blocks'){
   const single=content.blocks.length===1&&content.blocks[0].type==='paragraph'&&!content.blocks[0].children?.length;
   finishTreeChange(single&&target.blockId?pasteInlineFragment(state.draft.blocks,{...insertion,...content.blocks[0].data}):pasteEditorBlocks(state.draft.blocks,{...insertion,inserted:content.blocks}));
  }
  else{
   // Check the destination and document budget before uploading any bytes.
   pasteEditorBlocks(state.draft.blocks,{...insertion,inserted:content.files.map((file,index)=>createAttachmentBlock({id:'pasted-'+index,name:file.name,mediaType:file.mediaType},{pageId:state.current.page.id}))});
   void startClipboardUpload(content.files,insertion);
  }
 }catch(error){state.error=error?.message==='BLOCK_CLIPBOARD_ATTACHMENT_PAGE'?'clipboard.attachmentPage':clipboardError(error);refreshPageFeedback();}
 return true;
}
function advanceClipboardRevision(revision){
 if(!Number.isSafeInteger(revision)||revision<state.current.revision)throw new ApiError(0,'INVALID_RESPONSE');
 if(revision!==state.current.revision&&state.collection)state.collection.advanceDocumentBasis({expectedRevision:state.current.revision,revision,pageId:state.current.page.id,title:state.current.page.title});
 state.current.revision=revision;state.listRevision=revision;
}
function clipboardAttachmentSources(blocks){const sources=new Set();for(const {block}of indexEditorBlocks(blocks).values())for(const link of block.data?.links??[])if(link.attachmentId&&link.pageId!==state.current?.page.id)sources.add(link.pageId);return sources;}
async function transferClipboardAttachments(blocks,apply){
 if(clipboardStarting||clipboardUpload)return;const sources=clipboardAttachmentSources(blocks);if(sources.size!==1)return;const scope=blockDragScope(),basis=JSON.stringify(state.draft.blocks);clipboardStarting=true;app.inert=true;
 try{await autosave.flush();await settleBodySave();if(room&&!await settleRoom())throw new ApiError(409,'CONTENT_CONFLICT');if(scope!==blockDragScope()||basis!==JSON.stringify(state.draft.blocks)||bodyDirty()||state.collection?.dirty||state.conflict||bodySaveBlocked)throw new ApiError(409,'CONTENT_CONFLICT');
  const sourcePageId=[...sources][0],ids=new Set();for(const {block}of indexEditorBlocks(blocks).values())for(const link of block.data?.links??[])if(link.attachmentId)ids.add(link.attachmentId);
  const result=await request(basePath()+'/'+encodeURIComponent(state.current.page.id)+'/attachment-copies',{method:'POST',body:{expectedRevision:state.current.revision,expectedVersion:state.current.document.version,sourcePageId,blocks,copies:[...ids].map(sourceId=>({sourceId,targetId:crypto.randomUUID()}))}});
  if(scope!==blockDragScope()||basis!==JSON.stringify(state.draft.blocks)||result.version!==state.current.document.version)throw new ApiError(409,'CONTENT_CONFLICT');validateInlineBlockMetadata(result.blocks);advanceClipboardRevision(result.revision);state.current.attachments=[...(state.current.attachments??[]),...result.attachments];clipboardStarting=false;app.inert=false;apply(result.blocks);
 }catch(error){state.error=clipboardError(error);refreshPageFeedback();}finally{clipboardStarting=false;app.inert=false;}
}
async function startClipboardUpload(files,insertion){
 if(clipboardStarting||clipboardUpload)return;
 const scope=blockDragScope();clipboardStarting=true;app.inert=true;
 try{
  await settleBodySave();if(room&&!await settleRoom())throw new ApiError(409,'CONTENT_CONFLICT');await autosave.flush();
  if(scope!==blockDragScope()||bodyDirty()||state.conflict||bodySaveBlocked||state.collection?.dirty)throw new ApiError(409,'CONTENT_CONFLICT');
  const job={scope,insertion,tailId:null,focus:null,batch:null};
  const current=()=>clipboardUpload===job&&job.scope===blockDragScope();
  job.batch=new ClipboardUploadBatch({files,accountId:state.user.id,workspaceId,pageId:state.current.page.id,request:({path,...options})=>request(path,options),
   onReview:async envelope=>{
    if(!current())throw new ApiError(401,'ACCOUNT_CHANGED');
    const data=validatePageEnvelope(envelope,state.current.page.id);
    if(!data.page.capabilities.includes('editBody'))throw new ApiError(404,'CONTENT_NOT_FOUND');
    if(data.document.version!==state.current.document.version||data.page.title!==state.current.page.title||!pageBlocksEqual(data.document.blocks,state.current.document.blocks))throw new ApiError(409,'CONTENT_CONFLICT');
    if(state.collection&&data.revision!==state.current.revision){const collection=new CollectionEdits(await request(collectionPath()),{workspaceId,collectionId:state.current.page.collectionId});if(!current()||collection.revision!==data.revision)throw new ApiError(409,'CONTENT_CONFLICT');state.collection=collection;}
    state.current=data;state.listRevision=data.revision;
   },
   onAttachment:(attachment,result)=>{
    if(!current()||result.version!==state.current.document.version)throw new ApiError(409,'CONTENT_CONFLICT');
    advanceClipboardRevision(result.revision);
    state.current.attachments=[...(state.current.attachments??[]).filter(row=>row.id!==attachment.id),attachment];
    if(room)room.base.attachments=state.current.attachments;
    const existing=[...indexEditorBlocks(state.draft.blocks).values()].find(item=>isAttachmentBlock(item.block)&&item.block.data.links[0].attachmentId===attachment.id);
    if(existing){job.tailId=existing.block.id;return;}
    const block=createAttachmentBlock(attachment,{pageId:state.current.page.id});
    if(job.tailId){const tail=blockLocation(job.tailId);state.draft.blocks=insertEditorBlock(state.draft.blocks,{block,parentId:tail.parentId,index:tail.index+1});job.tailId=block.id;}
    else{const change=pasteEditorBlocks(state.draft.blocks,{...job.insertion,inserted:[block]});state.draft.blocks=change.blocks;job.tailId=change.lastInsertedId;job.focus=change.focus;}
    if(room){state.draft=clone(room.client.pasteTree(state.draft.blocks));presence.changed();}
    updateDirty();
   }});
  clipboardUpload=job;state.error='';state.notice='';
 }catch(error){state.error=clipboardError(error);}
 finally{clipboardStarting=false;app.inert=false;}
 if(clipboardUpload)await runClipboardUpload();else refreshPageFeedback();
}
async function runClipboardUpload(){
 const job=clipboardUpload;if(!job||state.busy)return;state.busy=true;state.error='';render();
 try{await job.batch.run();if(clipboardUpload===job){clipboardUpload=null;state.notice='clipboard.attached';}}
 catch(error){state.error=clipboardError(error);}
 finally{state.busy=false;updateDirty();render();if(!clipboardUpload&&job.focus)focusBlock(job.focus.blockId,job.focus.start);}
}
async function cancelClipboardUpload(){
 const job=clipboardUpload;if(!job||state.busy)return;state.busy=true;render();
 try{await job.batch.cancel();state.notice='clipboard.cancelled';state.error='';}
 catch{bodySaveBlocked='unknown';state.error='saveUnknown';}
 finally{clipboardUpload=null;state.busy=false;updateDirty();render();}
}
function renderPageAttachments() {
  const placed=new Set([...indexEditorBlocks(state.draft?.blocks??[]).values()].filter(row=>isAttachmentBlock(row.block)).map(row=>row.block.data.links[0].attachmentId));
  const attachments=state.current.attachments.filter(attachment=>!placed.has(attachment.id));
  if(!attachments.length)return document.createDocumentFragment();
  const list=node('ul',{class:'page-attachments'});
  for(const attachment of attachments) {
    if(!validId(attachment.id) || typeof attachment.name!=='string' || !Number.isSafeInteger(attachment.size) || attachment.size<0) continue;
    list.append(node('li',{},[node('a',{href:attachmentPath(attachment.id),download:attachment.name,translate:'no'},attachment.name),node('small',{},new Intl.NumberFormat(i18n.locale).format(attachment.size)+' B')]));
  }
  return node('section',{class:'attachments-section','aria-label':t('attachments')},[node('h2',{},t('attachments')),list,node('p',{class:'hint'},t('attachmentsHint'))]);
}
function collectionPath(collectionId = state.current?.page.collectionId) {
  return '/api/content/workspaces/' + encodeURIComponent(workspaceId) + '/collections/' + encodeURIComponent(collectionId);
}
async function syncCurrentRevision(observedRevision=null){
 if(room)return true;
 if(!state.current||state.loading||state.conflict||bodySaveBlocked)return false;
 if(observedRevision!==null&&observedRevision<=state.current.revision)return true;
 if(revisionRead)return revisionRead;
 const scope=collectionScope();
 const task=(async()=>{await settleBodySave();const baseline=state.current;if(scope!==collectionScope()||!baseline)return false;
  try{const fresh=validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(baseline.page.id)),baseline.page.id);if(scope!==collectionScope()||state.current!==baseline)return false;
   if(bodySaveTask){scheduleLiveRefresh();return false;}
   if(fresh.document.version!==baseline.document.version||fresh.page.title!==baseline.page.title||!pageBlocksEqual(fresh.document.blocks,baseline.document.blocks)){
    if(!draftPending()&&!roomCompositions.size&&!modalOpen()&&!wideBlockSelection())adoptLivePage(fresh);else scheduleLiveRefresh();return false;
   }
   if(fresh.revision>baseline.revision){pageReads.clear();if(state.collection)state.collection.advanceDocumentBasis({expectedRevision:baseline.revision,revision:fresh.revision,pageId:baseline.page.id,title:fresh.page.title});state.current=mergeSavedPageAttachments(baseline,fresh);state.listRevision=fresh.revision;}return true;
  }catch(error){if(scope===collectionScope()){state.error=errorKey(error,'loadFailed');refreshPageFeedback();}return false;}
 })();revisionRead=task;try{return await task;}finally{if(revisionRead===task)revisionRead=null;}
}
function applyLiveDirectory(data){
 if(data?.workspaceId!==workspaceId||!Number.isSafeInteger(data.revision)||!['owner','admin','member','guest'].includes(data.role)||!Array.isArray(data.pages)||data.pages.some(page=>!validId(page.id)||page.workspaceId!==workspaceId||typeof page.title!=='string'||!page.capabilities?.includes('read')))throw new ApiError(0,'INVALID_RESPONSE');
 state.pages=data.pages;state.listRevision=data.revision;state.role=data.role;
 if(Array.isArray(data.teamspaces)){state.teamspaces=data.teamspaces;state.teamsAvailable=true;}
}
function adoptLivePage(fresh){
 const old=state.current,changed=fresh.document.version!==old.document.version||fresh.page.title!==old.page.title||!pageBlocksEqual(fresh.document.blocks,old.document.blocks)||JSON.stringify(fresh.page.capabilities)!==JSON.stringify(old.page.capabilities)||JSON.stringify(fresh.page.appearance)!==JSON.stringify(old.page.appearance);
 const nextDraft={title:fresh.page.title,blocks:fresh.document.blocks},policyChanged=JSON.stringify(fresh.page.capabilities)!==JSON.stringify(old.page.capabilities)||JSON.stringify(fresh.page.appearance)!==JSON.stringify(old.page.appearance);
 const patch=!room&&changed&&!policyChanged?prepareLivePagePatch(app,state.draft,nextDraft):null;
 if(patch?.kind==='deferred'){scheduleLiveRefresh();return false;}
 state.current=mergeSavedPageAttachments(old,fresh);
 if(!room&&changed){
  const selection=editorSelection(),mapped=mapRoomSelection(state.draft,{title:fresh.page.title,blocks:fresh.document.blocks},selection),scroll=app.querySelector('.workspace-scroll'),top=scroll?.scrollTop??0,left=scroll?.scrollLeft??0;
  const inline=patch?.kind==='inline'&&patch.apply();
  if(!inline){placementUiStates=new Map([...databasePlacements].map(([id,view])=>[id,view.captureState()]));initialPlacements=new Map(Object.entries(fresh.context?.placements??{}));initialSynced=new Map(Object.entries(fresh.context?.synced??{}));state.draft={title:fresh.page.title,blocks:clone(fresh.document.blocks)};}
  if(editorHistory)editorHistory.acceptRemote(state.draft,mapped);else editorHistory=new EditorHistory(state.draft);observedDraft=draftSignature();draftGeneration++;autosave.reset();if(!inline)render();else for(const id of patch.changedIds){const row=document.getElementById('block-'+id);if(row)refreshBlockLinks(row,blockLocation(id).block);}
  const next=app.querySelector('.workspace-scroll');if(next){next.scrollTop=top;next.scrollLeft=left;}
  if(document.hasFocus?.()!==false){if(mapped?.title){const input=document.getElementById('page-title');input?.focus({preventScroll:true});input?.setSelectionRange(mapped.start,mapped.end);}
  else if(mapped?.blockId&&blockLocation(mapped.blockId))focusBlock(mapped.blockId,mapped.start,mapped.end);}
 }
 if(state.collection&&fresh.context?.collection){
  const next=new CollectionEdits(fresh.context.collection,{workspaceId,collectionId:state.collection.collection.id});
  if(!state.collection.dirty&&JSON.stringify(state.collection.envelope)!==JSON.stringify(next.envelope)){
   state.collection=next;state.people=fresh.context.people??[];
   if(fresh.page.recordId||fresh.page.templateId){const section=app.querySelector('.collection-editor');section?.replaceWith(renderCollection());}
   else if(collectionView)void collectionView.refresh();
  }
 }else if(state.collection&&!fresh.page.collectionId){state.collection=null;state.people=[];app.querySelector('.collection-editor')?.remove();}
 state.listRevision=fresh.revision;refreshSaveStatus();paintChrome();refreshChildPages();
}
function scheduleLiveRefresh(){
 if(signal.aborted)return;livePending=true;if(liveTimer||liveReading)return;
 liveTimer=setTimeout(()=>{liveTimer=null;void refreshLiveContent();},40);
}
async function refreshLiveContent(){
 if(!livePending||liveReading||!state.user||state.fatal||signal.aborted)return;
 if(document.hidden||state.loading||state.busy||state.listLoading||collectionActivities.size||bodySaveTask||draftPending()||roomCompositions.size||modalOpen()||draggedBlockId||resizingLayout||wideBlockSelection()||app.querySelector('.record-properties')?.contains(document.activeElement)){
  liveTimer=setTimeout(()=>{liveTimer=null;void refreshLiveContent();},250);return;
 }
 liveReading=true;livePending=false;const scope=collectionScope(),baseline=state.current,generation=draftGeneration;
 try{
  if(!baseline){const directory=await request(basePath()+'?context=1');if(!state.current){applyLiveDirectory(directory);paintChrome();}return;}
  const fresh=validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(baseline.page.id)+'?context=1&directory=1'),baseline.page.id);
  if(scope!==collectionScope()||state.current!==baseline||generation!==draftGeneration||draftPending()||bodySaveTask||roomCompositions.size||modalOpen()||wideBlockSelection()||app.querySelector('.record-properties')?.contains(document.activeElement)){livePending=true;return;}
  if(fresh.context?.accountId!==state.user.id)throw new ApiError(0,'INVALID_RESPONSE');
  pageReads.clear();if(fresh.context.directory)applyLiveDirectory(fresh.context.directory);
  if(room){queueRoomSync(room,0);fresh.document=baseline.document;fresh.page.title=baseline.page.title;}
  adoptLivePage(fresh);
 }catch(error){if(scope===collectionScope()&&[401,403,404].includes(error.status)){destroyRoom();pageReads.clear();state.current=null;state.draft=null;state.collection=null;state.locked=true;state.error=errorKey(error,'loadFailed');render();}}
 finally{liveReading=false;if(livePending)scheduleLiveRefresh();}
}
async function placementPeople(envelope){if(!envelope.collection.properties.some(property=>property.type==='person'))return[];if(Array.isArray(envelope.people))return envelope.people;const result=await request(basePath()+'/'+encodeURIComponent(envelope.pageId)+'/people');return result.people??[];}
async function openSyncedPicker(target){
 if(room||!structureAllowed(target.parentId))return;const scope=collectionScope(),status=node('p',{},t('loading'));showModal('synced.insert',[status]);try{const candidates=await loadPageReferenceCandidates();if(scope!==collectionScope()||!modal.open)return;const list=node('div',{class:'block-picker'}),insert=async sourceId=>{if(scope!==collectionScope())return;await closeModalFully();rememberEditorSelection();finishTreeChange({blocks:insertEditorBlock(state.draft.blocks,{block:{id:crypto.randomUUID(),type:'synced-block',data:{format:'synced-page-v1',pageId:sourceId}},parentId:target.parentId,index:target.index})});await autosave.flush();};for(const page of candidates.filter(page=>page.id!==state.current.page.id))list.append(node('button',{type:'button',class:'button',onClick:()=>void insert(page.id)},page.title));const name=node('input',{type:'text',maxlength:'240',value:t('synced.defaultName'),'aria-label':t('synced.name')});const create=button('create',async()=>{if(scope!==collectionScope()||!name.value.trim())return;const title=name.value.trim();await closeModalFully();await autosave.flush();if(bodyDirty()||!await syncCurrentRevision())return;state.busy=true;try{const created=await request(basePath(),{method:'POST',body:{expectedRevision:state.current.revision,title,blocks:[{id:crypto.randomUUID(),type:'paragraph',data:{text:''}}]}});state.busy=false;await syncCurrentRevision();await insert(created.page.id);void refreshList();}catch(error){state.error=errorKey(error,'saveFailed');}finally{state.busy=false;refreshPageFeedback();}});status.replaceChildren(node('p',{},t('synced.permissionHint')),node('h3',{},t('synced.existing')),list,node('h3',{},t('synced.create')),node('label',{class:'field'},[t('synced.name'),name]),create);}catch{status.textContent=t('synced.unavailable');}
}
async function removeSyncedPlacement(blockId){
 if(structureDisabled()||!structureAllowed(blockId))return;showModal('synced.remove',[node('p',{},t('synced.removeHint')),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),button('synced.remove',async()=>{if(!await detailPanel.close())return;await closeModalFully();rememberEditorSelection();finishTreeChange(removeEditorBlocks(state.draft.blocks,[blockId]));await autosave.flush();},{primary:true})])]);
}
async function detachSyncedBlock(blockId){
 const placement=blockLocation(blockId)?.block,scope=collectionScope();if(!isSyncedBlock(placement)||structureDisabled())return;showModal('synced.detach',[node('p',{},t('synced.detachHint')),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),button('synced.detach',async()=>{if(!await detailPanel.close())return;await closeModalFully();await autosave.flush();if(bodyDirty()||!await syncCurrentRevision())return;try{const source=validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(placement.data.pageId)),placement.data.pageId);if(scope!==collectionScope())return;const copy=items=>items.map(block=>{const next={...clone(block),id:crypto.randomUUID()};for(const key of ['mentions','links'])if(next.data?.[key]){next.data[key]=next.data[key].filter(reference=>!reference.unavailable);if(!next.data[key].length)delete next.data[key];}if(next.children)next.children=copy(next.children);return next;});let blocks=copy(source.document.blocks);if(!blocks.length)blocks=[{id:crypto.randomUUID(),type:'paragraph',data:{text:''}}];const apply=inserted=>{if(scope!==collectionScope()||blockLocation(blockId)?.block!==placement)return;rememberEditorSelection();finishTreeChange(replaceEditorBlockSelection(state.draft.blocks,[blockId],inserted));void autosave.flush();};if(clipboardAttachmentSources(blocks).size)await transferClipboardAttachments(blocks,apply);else apply(blocks);}catch(error){state.error=errorKey(error,'saveFailed');refreshPageFeedback();}},{primary:true})])]);
}
async function openDatabasePicker(target){
 if(room||!structureAllowed(target.parentId))return;const scope=collectionScope(),status=node('p',{role:'status'},t('loading'));
 showModal('inlineDatabase.insert',[status]);
 try{const list=await request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/collections');if(scope!==collectionScope()||!modal.open||modal.dataset.view!=='inlineDatabase.insert')return;
  const choices=node('div',{class:'block-picker'});for(const item of list.collections){const choice=node('button',{type:'button',class:'button',translate:'no'},item.title);choice.addEventListener('click',()=>void insertDatabase(item.id,target));choices.append(choice);}
  const name=node('input',{type:'text',maxlength:'240',value:t('inlineDatabase.defaultName'),'aria-label':t('inlineDatabase.name')});
  const create=button('inlineDatabase.create',async()=>{if(!name.value.trim())return;const title=name.value.trim();await closeModalFully();await autosave.flush();if(bodyDirty()||!await syncCurrentRevision())return;state.busy=true;refreshSaveStatus();try{const result=await request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/collections',{method:'POST',body:{expectedRevision:state.current.revision,title,parentId:state.current.page.capabilities.includes('manage')?state.current.page.id:null,properties:[{id:crypto.randomUUID(),name:t('inlineDatabase.status'),type:'status',options:[t('inlineDatabase.todo'),t('inlineDatabase.doing'),t('inlineDatabase.done')]},{id:crypto.randomUUID(),name:t('inlineDatabase.assignee'),type:'person'},{id:crypto.randomUUID(),name:t('inlineDatabase.due'),type:'date'}]}});state.busy=false;await syncCurrentRevision();await insertDatabase(result.collectionId,target);void refreshList();}catch(error){state.busy=false;state.error=errorKey(error,'saveFailed');refreshPageFeedback();}} ,{primary:true,disabled:!list.canCreate});
  status.replaceChildren(node('p',{},t('inlineDatabase.sourcePermission')),node('h3',{},t('inlineDatabase.existing')),choices,node('h3',{},t('inlineDatabase.create')),node('label',{class:'field'},[t('inlineDatabase.name'),name]),create);
 }catch(error){status.textContent=t('inlineDatabase.unavailable');}
}
async function insertDatabase(collectionId,target){
 const scope=collectionScope();await closeModalFully();if(scope!==collectionScope()||!structureAllowed(target.parentId))return;
 const block={id:crypto.randomUUID(),type:'database',data:{format:'collection-view-v1',collectionId,view:defaultDatabaseView(fieldT('table')),visiblePropertyIds:null}};
 try{rememberEditorSelection();finishTreeChange({blocks:insertEditorBlock(state.draft.blocks,{block,parentId:target.parentId,index:target.index})});await autosave.flush();}catch(error){state.error=nestingError(error);refreshPageFeedback();}
}
async function openDatabaseSettings(blockId,envelope){
 const location=blockLocation(blockId),scope=collectionScope();if(room||!location||!structureAllowed(blockId))return;
 try{envelope??=await request(collectionPath(location.block.data.collectionId));const people=await placementPeople(envelope);if(scope!==collectionScope())return;
  const settings=createDatabaseViewSettings({document,properties:envelope.collection.properties,view:location.block.data.view,visiblePropertyIds:location.block.data.visiblePropertyIds,people,pages:state.pages,t:fieldT}),feedback=node('p',{role:'status'});
  const save=button('save',async()=>{if(scope!==collectionScope()||state.busy)return;let config;try{config=settings.read();await request(collectionPath(location.block.data.collectionId)+'/query',{method:'POST',body:{view:config.view}});}catch{feedback.textContent=fieldT('invalidValue');return;}if(scope!==collectionScope()||blockLocation(blockId)?.block!==location.block)return;rememberEditorSelection();location.block.data={...location.block.data,...config};await closeModalFully();updateDirty();render();await autosave.flush();},{primary:true});
  showModal('inlineDatabase.settings',[node('p',{class:'hint'},t('inlineDatabase.localSettings')),settings.element,feedback,node('a',{class:'button',href:'/collections?'+new URLSearchParams({workspace:workspaceId,collection:location.block.data.collectionId}),target:'_blank',rel:'noopener'},t('inlineDatabase.manageSource')),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),save])]);
 }catch{state.error='inlineDatabase.unavailable';refreshPageFeedback();}
}
async function changeInlineDatabaseView(blockId,view,revision=null){
 const location=blockLocation(blockId),scope=collectionScope();if(room||structureDisabled()||!location||!isDatabaseBlock(location.block)||!structureAllowed(blockId))return false;
 if(!await detailPanel.close()||!await syncCurrentRevision(revision)||scope!==collectionScope()||blockLocation(blockId)?.block!==location.block||structureDisabled()||state.conflict||bodySaveBlocked)return false;
 location.block.data={...location.block.data,view:clone(view)};updateDirty();void autosave.flush();return scope===collectionScope();
}
async function createInlineRecord(envelope){
 if(!envelope?.capabilities.includes('manage')||state.busy||modalOpen())return;const scope=collectionScope();
 try{const people=await placementPeople(envelope);if(scope!==collectionScope())return;const title=node('input',{type:'text',maxlength:'240',required:true,value:t('newPage'),'aria-label':fieldT('recordTitle')}),values=new Map(),feedback=node('p',{role:'status'});
  let templateId='';const fields=node('div');const renderFields=template=>{values.clear();fields.replaceChildren(...envelope.collection.properties.filter(property=>!isComputedProperty(property)).map(property=>{const initial=template?.values[property.id]??envelope.view?.filters.find(filter=>filter.propertyId===property.id&&filter.operator==='eq')?.value??null,input=createCollectionValueInput({document,property,value:initial,people,pages:state.pages,t:fieldT});values.set(property.id,input);return node('label',{class:'field'},[property.name,input]);}));};renderFields(null);const picker=createTemplatePicker({document,collection:envelope.collection,t:fieldT,onChange:template=>{templateId=template?.id??'';if(template)title.value=template.name;renderFields(template);}});
  showModal('inlineDatabase.newRecord',[node('label',{class:'field'},[fieldT('recordTemplate'),picker]),node('label',{class:'field'},[fieldT('recordTitle'),title]),fields,feedback,node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),button('create',async()=>{if(scope!==collectionScope()||!title.value.trim())return;let raw;try{raw=Object.fromEntries([...values].map(([id,input])=>[id,input.readValue()]));}catch{feedback.textContent=fieldT('invalidValue');return;}
   await closeModalFully();await autosave.flush();if(bodyDirty()||!await syncCurrentRevision())return;state.busy=true;refreshSaveStatus();try{const result=await request(collectionPath(envelope.collection.id)+'/records',{method:'POST',body:{expectedRevision:state.current.revision,title:title.value.trim(),values:raw,...(templateId?{templateId}:{})}});state.busy=false;await syncCurrentRevision();for(const controller of databasePlacements.values())void controller.refresh(true);void openRecordDetail(result.record,envelope.collection.id);}catch(error){state.busy=false;state.error=errorKey(error,'recordSaveFailed');refreshPageFeedback();}},{primary:true})])]);
 }catch{state.error='inlineDatabase.unavailable';refreshPageFeedback();}
}
function pageReferenceHref(link){return '/workspace?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(link.pageId)+(link.fragment?'#'+encodeURIComponent(link.fragment.toWellFormed()):'');}
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
      } else preview.append(node('a',{href:'/workspace?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(link.pageId)+(link.fragment?'#'+encodeURIComponent(link.fragment.toWellFormed()):''),translate:'no'},link.label));
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
  const model=state.collection, disabled=readOnly || !!room&&room.phase!=='ready' || state.busy || collectionActivities.size>0 || state.loading || state.locked || state.conflict || !model.canEdit(record.id);
  const inputs=model.collection.properties.map(property=> {
    const immutable=isComputedProperty(property) || record.redactedProperties?.includes(property.id);
    let input;
    if(immutable)input=renderRecordCollectionValue({record,property,document,people:state.people,pages:state.pages,t:fieldT});
    else {
      input=createCollectionValueInput({document,property,value:model.rawValue(record.id,property.id),people:state.people,pages:state.pages,t:fieldT,disabled:disabled || !model.canEdit(record.id,property.id)});
      input.setAttribute('aria-label',t('cellValue',{column:property.name,row:recordName(record,index)}));input.setAttribute('translate','no');
      if(input.disabled && ['INPUT','TEXTAREA'].includes(input.tagName)){input.disabled=false;input.readOnly=true;}
      input.addEventListener('input',()=> {
        if(disabled || state.busy || state.loading || state.locked || state.conflict || bodySaveBlocked || collectionActivities.size>0 || state.collection!==model || !model.canEdit(record.id,property.id))return;
        try {model.setRaw(record.id,property.id,input.rawValue());}catch{state.recordError='recordInvalidValue';return;}
        state.recordError='';updateDirty();refreshRecordFeedback();
      });
      input.addEventListener('compositionstart',()=>{roomCompositions.add(input);autosave.refresh();});
      input.addEventListener('compositionend',()=>{roomCompositions.delete(input);autosave.refresh();});
    }
    const hint=collectionFieldHint(property,{record,t:fieldT}),content=node('div',{class:'record-field-content',...(immutable?{'data-computed-property':property.id,'data-computed-record':record.id}:{})},[input,...(hint?[node('small',{class:'hint'},hint)]:[])]);
    return table ? node('td',{},content) : node('label',{class:'field record-property'},[node('span',{translate:'no'},property.name),content]);
  });
  const actions=node('div',{class:'record-actions'},[button('originalCells',()=>openSourceCells(record))]);
  if (!table) return node('div',{class:'record-properties'},[...inputs,actions]);
  return node('tr',{},[node('th',{scope:'row'},node('button',{type:'button',class:'record-page-link',onClick:()=>openCollectionRecord(record),disabled:state.busy,translate:'no'},recordName(record,index))),...inputs,node('td',{},actions)]);
}
function renderCollection() {
  const model=state.collection, recordId=state.current.page.recordId;
  const section=node('section',{class:'collection-editor','aria-label':t(recordId?'recordProperties':'collectionTable')});
  section.append(node('div',{class:'collection-heading'},[node('h2',{},t(recordId?'recordProperties':'collectionTable')),node('span',{class:'hint'},t('typedColumns'))]));
  section.append(node('p',{class:'message',role:'alert','data-record-feedback':'',hidden:!state.recordError},recordErrorText()));
  if (model.conflict) section.append(node('p',{class:'hint'},t('recordConflict')));
  if(state.current.page.templateId){section.append(node('p',{class:'hint'},fieldT('templateBodyHint')),button('databaseTemplates',()=>void openDatabaseTemplates(model.envelope),{disabled:!!room||state.busy}));return section;}
  if (recordId) {
    const record=model.record(recordId);
    section.append(record?recordEditor(record,0):node('p',{class:'hint'},t('recordUnavailable'))); return section;
  }
  const views=node('div',{class:'workspace-collection-views'});section.append(views);
  section.append(button('databaseTemplates',()=>void openDatabaseTemplates(model.envelope),{disabled:!!room||state.busy}));
  const scope=collectionScope();
  queueMicrotask(()=>{if(views.isConnected&&scope===collectionScope()&&state.collection===model)mountCollectionViews(views,scope);});
  return section;
}
function collectionScope(){return state.current&&state.user?JSON.stringify([state.user.id,workspaceId,state.current.page.id,state.selection]):null;}
async function openDatabaseTemplates(envelope){
 if(room||state.busy)return;const scope=collectionScope();await autosave.flush();if(bodyDirty()||!await syncCurrentRevision()||scope!==collectionScope())return;
 try{envelope=validateCollectionEnvelope(await request(collectionPath(envelope.collection.id)),{workspaceId,collectionId:envelope.collection.id});const people=await placementPeople(envelope);if(scope!==collectionScope())return;
 const manager=createTemplateManager({document,envelope,t:fieldT,people,pages:state.pages,pageHref:pageId=>'/workspace?'+new URLSearchParams({workspace:workspaceId,page:pageId}),available:()=>scope===collectionScope()&&!state.locked&&!state.conflict,save:async(body,id,action)=>{if(!await syncCurrentRevision()||scope!==collectionScope())throw new Error('changed');state.busy=true;try{await request(collectionPath(envelope.collection.id)+'/templates'+(id?'/'+encodeURIComponent(id):''),{method:action==='remove'?'DELETE':id?'PATCH':'POST',body:{expectedRevision:state.current.revision,...body}});await syncCurrentRevision();const next=validateCollectionEnvelope(await request(collectionPath(envelope.collection.id)),{workspaceId,collectionId:envelope.collection.id});if(state.collection?.collection.id===envelope.collection.id)state.collection=new CollectionEdits(next,{workspaceId,collectionId:envelope.collection.id});pageReads.clear();void refreshList();return next;}finally{state.busy=false;refreshSaveStatus();}}});showModal('databaseTemplates',[manager]);
 }catch(error){state.error=errorKey(error,'recordSaveFailed');refreshPageFeedback();}
}
async function collectionActor(actorId,signal){const session=await request('/api/auth/get-session',{signal});if(session?.user?.id!==actorId||session.user.emailVerified!==true)throw new ApiError(401,'ACCOUNT_CHANGED');}
function mountCollectionViews(root,scope){
 const actorId=state.user.id,pageId=state.current.page.id,collectionId=state.collection.collection.id,token={},pendingPages=new WeakMap();let ownsWrite=false;
 const current=()=>collectionScope()===scope&&state.current?.page.id===pageId&&state.collection?.collection.id===collectionId;
 const canRead=()=>current()&&!state.locked&&!state.loading&&(!state.busy||ownsWrite)&&!bodySaveTask&&!modalOpen();
 const canWrite=()=>canRead()&&!room&&!state.conflict&&!bodySaveBlocked&&!state.collection.conflict&&!roomCompositions.size;
 const release=(busy,kind)=>{if(busy){collectionActivities.add(token);if(kind==='write'){ownsWrite=true;state.busy=true;}}else{collectionActivities.delete(token);if(ownsWrite){ownsWrite=false;state.busy=false;}}autosave.refresh();refreshSaveStatus();};
 const readView=async(viewId,{signal})=>{
  const activeRoom=room,baseline=state.current;
  const page=await request(basePath()+'/'+encodeURIComponent(pageId)+'?context=1'+(viewId?'&view='+encodeURIComponent(viewId):''),{signal});
  if(page.context?.accountId!==actorId||!current()||room!==activeRoom)throw new ApiError(409,'COLLECTION_READ_CHANGED');
  const value=page.context.collection;
  const fresh=validatePageEnvelope(page,pageId),next=validateWorkspaceCollectionRead(value,fresh,{workspaceId,collectionId,pageId,baseline,inRoom:!!activeRoom,expectedViewId:viewId});
  pendingPages.set(next,{fresh,activeRoom});
  return next;
 };
 if(collectionViewId&&!state.collection.collection.views.some(view=>view.id===collectionViewId))collectionViewId=null;
 const controller=mountWorkspaceCollectionView({root,getModel:()=>state.collection,isCurrent:current,canRead,canWrite,readView,
  selectedViewId:collectionViewId,labels:fieldT,
  prepare:async kind=>{await settleBodySave();return current()&&canRead()&&(kind==='read'?collectionRecovery||!state.conflict&&!bodySaveBlocked:canWrite());},
  onBusyChange:release,
  onModel:next=>{if(!current())return;const basis=pendingPages.get(next);if(!basis||room!==basis.activeRoom)throw new ApiError(409,'COLLECTION_READ_CHANGED');if(!basis.activeRoom){state.current=mergeSavedPageAttachments(state.current,basis.fresh);state.listRevision=basis.fresh.revision;}pendingPages.delete(next);state.collection=next;collectionRefresh=false;state.collectionError=state.recordError='';if(collectionRecovery){collectionRecovery=false;state.conflict=false;if(['unknown','refresh'].includes(bodySaveBlocked))bodySaveBlocked='';}updateDirty();},
  onSelected:id=>{collectionViewId=id;const url=new URL(location.href);if(id)url.searchParams.set('view',id);else url.searchParams.delete('view');history.replaceState(null,'',url);},
  confirmDiscard:confirmCollectionProperties,
  createView:async(body,{signal})=>{await collectionActor(actorId,signal);if(!current()||!canWrite()||!state.collection.envelope.capabilities.includes('manage'))throw new ApiError(409,'COLLECTION_READ_CHANGED');const result=await request(collectionPath(collectionId)+'/views',{method:'POST',body,signal});await collectionActor(actorId,signal);return result;},
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
 collectionReviewActive=true;try{await autosave.flush();await settleBodySave();}finally{collectionReviewActive=false;}if(!state.collection?.dirty)return true;
 return new Promise(resolve=>{let confirmed=false;showModal('confirmDiscardTitle',[node('p',{},fieldT('embeddedDiscardProperties')),node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),button('discard',()=>{confirmed=true;modal.close();},{primary:true})])]);modal.addEventListener('close',()=>resolve(confirmed),{once:true});});
}
function openCollectionRecord(record){
 if(state.busy||modalOpen()||roomCompositions.size||!state.collection?.record(record.id))return;
 void openRecordDetail(record,state.collection.collection.id);
}
async function openRecordDetail(record,collectionId){
 if(detailMode){window.open('/workspace?'+new URLSearchParams({workspace:workspaceId,page:record.pageId}),'_blank','noopener');return;}
 if(await detailPanel.open(record,collectionId)){for(const row of app.querySelectorAll('[data-record-id]'))row.classList.toggle('record-selected',row.dataset.recordId===record.id);}
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
function refreshCollectionAfterEditing(){
 if(!collectionRefresh||collectionReviewActive||!collectionView||state.dirty||bodySaveTask||state.busy||state.loading||state.conflict||bodySaveBlocked||modalOpen()||document.activeElement?.closest?.('.collection-value-input'))return;
 collectionRefresh=false;void collectionView.refresh();
}
function recordErrorText(){return state.recordError?['assigneeNotificationLimit','embeddedPropertiesChanged'].includes(state.recordError)?fieldT(state.recordError):t(state.recordError):'';}
function refreshRecordFeedback(){
  if(state.collection?.conflict)for(const input of app.querySelectorAll('.collection-value-input')){if(['INPUT','TEXTAREA'].includes(input.tagName))input.readOnly=true;else input.disabled=true;}
  for(const host of app.querySelectorAll('[data-record-feedback]')){host.textContent=recordErrorText();host.hidden=!state.recordError;}
  refreshSaveStatus();
}
function refreshComputedProperties(record){
  for(const host of app.querySelectorAll('[data-computed-property]')){
    if(host.dataset.computedRecord!==record.id)continue;
    const property=state.collection.property(host.dataset.computedProperty),hint=host.querySelector('small');
    host.replaceChildren(renderRecordCollectionValue({record,property,document,people:state.people,pages:state.pages,t:fieldT}),...(hint?[hint]:[]));
  }
}
/** The autosave adapter is the only writer; body and property requests share its single flight. */
async function persistRecord(recordId,{isCurrent}) {
  const model=state.collection;
  if(!isCurrent()||!model?.canEdit(recordId)||state.busy||state.loading||state.locked||state.conflict||roomCompositions.size||room&&room.phase!=='ready')return {status:'paused'};
  if(room){
    const active=room;
    if(!await settleRoom()||!isCurrent()||room!==active)return {status:'paused'};
    recordWriteActive=true;
    try{const envelope=await request(collectionPath());if(!isCurrent()||room!==active)return {status:'paused'};Object.assign(model,model.rebase(envelope));state.current.revision=model.revision;state.listRevision=model.revision;}
    catch{model.markConflict();state.conflict=true;state.recordError='recordConflict';return {status:'conflict'};}
  }
  let patch;
  try{patch=model.patch(recordId);}catch{state.recordError='recordInvalidValue';return {status:'paused'};}
  if(!patch){model.discard(recordId);state.recordError='';return {status:'saved'};}
  const submitted={patch,values:model.values(recordId)};
  state.recordError='';state.notice='';
  try{
    const response=await request(collectionPath()+'/records/'+encodeURIComponent(recordId),{method:'PATCH',body:patch});
    if(!isCurrent()||state.collection!==model)return {status:'paused'};
    try{model.accept(response,recordId,submitted);}catch{throw new ApiError(0,'INVALID_RESPONSE');}
    state.current.revision=response.revision;state.listRevision=response.revision;collectionRefresh=true;
    refreshComputedProperties(model.record(recordId));
    if(room){room.needsSync=true;queueRoomSync(room);}
    return {status:'saved'};
  }catch(error){
    if(!isCurrent()||state.collection!==model)return {status:'paused'};
    if(error.status===409){model.markConflict();state.conflict=true;state.recordError='recordConflict';return {status:'conflict'};}
    if(![400,401,403,404,413,422].includes(error.status)){model.markUnknown();bodySaveBlocked='unknown';state.recordError='recordUnknown';return {status:'unknown'};}
    bodySaveBlocked='rejected';state.recordError=error.code==='NOTIFICATIONS_TOO_LARGE'?'assigneeNotificationLimit':errorKey(error,'recordSaveFailed');return {status:'rejected'};
  }
}

function focusBlock(id, offset = 0, end = offset) {
 if(afterModalExit(()=>focusBlock(id,offset,end)))return;
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
 if(choice==='equation'&&(block.data?.text?.length??0)>10000)throw new RangeError('TEXT_TOO_LONG');
 if(/^heading[123]$/.test(choice)) {block.type='heading';block.data={...block.data,level:Number(choice.at(-1))};}
 else {block.type=choice;if(['code','equation','divider'].includes(choice) && block.data){delete block.data.marks;delete block.data.mentions;delete block.data.links;}if(choice==='checklist')block.data={...block.data,checked:block.data?.checked===true};if(choice==='numbered-list')block.data={...block.data,start:1};}
}
function openBookmark(target){
 const scope=blockDragScope(),url=node('input',{type:'url',required:true,'aria-label':t('blocks.url'),placeholder:'https://…'}),title=node('input',{type:'text',maxLength:240,'aria-label':t('blocks.linkTitle')}),status=node('p',{role:'alert'});
 const save=button('addBlock',()=>{if(scope!==blockDragScope()||room||!structureAllowed(target.parentId))return;try{const block=createBookmarkBlock(url.value,title.value);rememberEditorSelection();state.draft.blocks=insertEditorBlock(state.draft.blocks,{block,parentId:target.parentId,index:target.index});updateDirty();modal.close();render();}catch{status.textContent=t('inline.invalidLink');}},{primary:true});
 showModal('blocks.bookmark',[node('label',{class:'field'},[t('blocks.url'),url]),node('label',{class:'field'},[t('blocks.linkTitle'),title]),status,save]);url.focus();
}
function duplicateBlocks(blockIds){if(room||structureDisabled()||state.conflict||bodySaveBlocked)return;rememberEditorSelection();try{const result=duplicateEditorBlocks(state.draft.blocks,blockIds);modal.close();finishTreeChange(result);}catch(error){state.error=nestingError(error);refreshPageFeedback();}}
async function copyBlockLink(blockId){
 if(!blockLocation(blockId))return;const url=new URL(location.href);url.hash='block-'+blockId;
 try{await navigator.clipboard.writeText(url.href);state.notice='blocks.linkCopied';state.error='';modal.close();refreshPageFeedback();}
 catch{const input=node('input',{type:'text',readOnly:true,value:url.href,'aria-label':t('blocks.copyLink')});showModal('blocks.copyLink',[input]);input.focus();input.select();}
}
function blockPresentationControls(block){
 const controls=[];if(block.type==='callout'){const iconInput=node('input',{type:'text',value:block.data?.icon||'💡',maxLength:32,'aria-label':t('blocks.icon'),disabled:!!room});iconInput.addEventListener('change',()=>{if(room||!structureAllowed(block.id)||!validBlockIcon(iconInput.value))return;rememberEditorSelection();block.data={...block.data,icon:iconInput.value};updateDirty();modal.close();render();});controls.push(node('label',{class:'field'},[t('blocks.icon'),iconInput]));}
 for(const key of ['color','background']){const select=node('select',{'aria-label':t('blocks.'+key),disabled:!!room},BLOCK_COLORS.map(color=>node('option',{value:color},t('blocks.colors.'+color))));select.value=block.data?.[key]||'default';select.addEventListener('change',()=>{if(room||!structureAllowed(block.id)||!BLOCK_COLORS.includes(select.value))return;rememberEditorSelection();block.data={...block.data,[key]:select.value};updateDirty();modal.close();render();});controls.push(node('label',{class:'field'},[t('blocks.'+key),select]));}
 return controls;
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
 if(existingId===null){const option=button('simpleTable.add',()=>{if(room&&!room.client?.supportsFeature('content-blocks')||!structureAllowed(target.parentId))return;rememberEditorSelection();try{const block={id:crypto.randomUUID(),type:'table',data:createSimpleTable()};const blocks=insertEditorBlock(state.draft.blocks,{block,parentId:target.parentId,index:target.index});modal.close();finishTreeChange({blocks,focus:{blockId:block.id,start:0}});}catch(error){state.error=nestingError(error);modal.close();render();}},{class:'block-choice',disabled:!!room&&!room.client?.supportsFeature('content-blocks'),title:room&&!room.client?.supportsFeature('content-blocks')?t('simpleTable.roomReadOnly'):undefined});option.setAttribute('role','menuitem');menu.append(option);}
 if(existingId===null){const option=button('inlineDatabase.insert',()=>void openDatabasePicker(target),{class:'block-choice',disabled:!!room});option.setAttribute('role','menuitem');menu.append(option);}
 if(existingId===null){const option=button('synced.insert',()=>void openSyncedPicker(target),{class:'block-choice',disabled:!!room});option.setAttribute('role','menuitem');menu.append(option);}
 if(existingId===null)for(const choice of [...GENERATED_BLOCK_TYPES,'bookmark']){const option=button('blocks.'+({ 'table-of-contents':'tableOfContents',breadcrumb:'breadcrumb',bookmark:'bookmark'})[choice],()=>{
  if(room||!structureAllowed(target.parentId))return;
  if(choice==='bookmark'){openBookmark(target);return;}
  rememberEditorSelection();const block={id:crypto.randomUUID(),type:choice,data:{}};state.draft.blocks=insertEditorBlock(state.draft.blocks,{block,parentId:target.parentId,index:target.index});updateDirty();modal.close();render();
 },{class:'block-choice',disabled:!!room});option.setAttribute('role','menuitem');menu.append(option);}
 for(const count of [2,3]){const allowed=!room&&(existingId===null?columnsAt(target.parentId):columnsAt(blockLocation(existingId)?.parentId)&&!blockHasColumns(existing));const option=button(count===2?'columns.addTwo':'columns.addThree',()=>addColumns(count,existingId,target),{class:'block-choice',disabled:!allowed,title:room?t('roomStopFirst'):!allowed?t('columns.nested'):undefined});option.setAttribute('role','menuitem');menu.append(option);}
 const search=node('input',{type:'search','aria-label':t('blocks.search'),placeholder:t('blocks.search')});search.addEventListener('input',()=>{const query=search.value.trim().toLocaleLowerCase();for(const button of menu.querySelectorAll('button'))button.hidden=!!query&&!button.textContent.toLocaleLowerCase().includes(query);});
 search.addEventListener('keydown',event=>{const first=[...menu.querySelectorAll('button:not(:disabled)')].find(button=>!button.hidden);if(first&&['Enter','ArrowDown'].includes(event.key)){event.preventDefault();if(event.key==='Enter')first.click();else first.focus();}});
 menu.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const choices=[...menu.querySelectorAll('button:not(:disabled)')].filter(button=>!button.hidden),current=choices.indexOf(document.activeElement);const next=event.key==='Home'?0:event.key==='End'?choices.length-1:(current+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;choices[next]?.focus();});
 showModal(existingId===null?'addBlock':'blockType',[search,menu,node('p',{class:'hint'},t('blockKeys'))]);search.focus();
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
 if(isDatabaseBlock(block))return openDatabaseActions(blockId,databasePlacements.get(blockId)?.envelope);
 if(block.type==='table'&&isSimpleTableData(block.data)||isAttachmentBlock(block)||GENERATED_BLOCK_TYPES.includes(block.type)||isBookmarkBlock(block))return openSimpleTableActions(blockId);
 const capturedScope=blockDragScope(),active=room,conversionAllowed=choice=>{if(!active)return true;if(!active.client.supportsFeature('block-transforms'))return false;try{prepareRoomConvertOperation(state.draft.blocks,{blockId,choice,seedBlocks:active.client.seed.blocks});return true;}catch{return false;}};
 const select=node('select',{'aria-label':t('blockType'),disabled:!!room&&!room.client.supportsFeature('block-transforms')},blockChoices.map(choice=>node('option',{value:choice,disabled:!conversionAllowed(choice)||choice==='divider'&&!!block.data?.text||!!block.children?.length&&!EDITOR_PARENT_TYPES.includes(/^heading[123]$/.test(choice)?'heading':choice)},t(choice))));select.value=choiceForBlock(block);
 select.addEventListener('change',()=>{if(capturedScope!==blockDragScope()||room!==active||blockLocation(blockId)?.block!==block||!structureAllowed(blockId)||state.conflict||bodySaveBlocked)return;rememberEditorSelection();try{if(active){const operation=prepareRoomConvertOperation(state.draft.blocks,{blockId,choice:select.value,seedBlocks:active.client.seed.blocks});modal.close();finishRoomTransform({operation,focus:{blockId,start:0}});}else{convertBlock(block,select.value);updateDirty();modal.close();render();focusBlock(block.id);}}catch(error){state.error=nestingError(error);modal.close();render();}});
 const move=offset=>{if(!structureAllowed(blockId))return;const current=blockLocation(blockId),target=current.index+offset;if(target<0||target>=current.siblings.length)return;rememberEditorSelection();const blocks=moveEditorBlockTo(state.draft.blocks,{blockId,targetId:current.siblings[target].id,placement:offset<0?'before':'after'});modal.close();finishTreeChange({blocks,roomBlockIds:[blockId],focus:{blockId,start:0}});};
 const indent=nestingAvailability(blockId,'indent'),outdent=nestingAvailability(blockId,'outdent'),canParent=EDITOR_PARENT_TYPES.includes(block.type)&&location.depth<MAX_EDITOR_NESTING-1;
 showModal('blockType',[node('label',{class:'field'},[t('blockType'),select]),...blockPresentationControls(block),node('div',{class:'block-action-list'},[
  button('blocks.duplicate',()=>duplicateBlocks([blockId]),{disabled:!!room}),button('blocks.copyLink',()=>void copyBlockLink(blockId)),
  ...(blockLocation(blockId,state.current.document.blocks)?[node('a',{class:'button',href:'/comments?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(state.current.page.id)+'&block='+encodeURIComponent(blockId)},t('blockComments'))]:[button('blockComments',()=>{},{disabled:true,title:t('blockCommentSaveFirst')})]),
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
 if(!structureAllowed(blockId))return;const location=blockLocation(blockId);if(!location)return;
 const move=offset=>{if(room||!structureAllowed(blockId))return;const current=blockLocation(blockId),target=current.index+offset;if(target<0||target>=current.siblings.length)return;rememberEditorSelection();const blocks=moveEditorBlockTo(state.draft.blocks,{blockId,targetId:current.siblings[target].id,placement:offset<0?'before':'after'});modal.close();finishTreeChange({blocks,focus:{blockId,start:0}});};
 showModal(isAttachmentBlock(location.block)?'clipboard.attachment':location.block.type==='table'?'simpleTable.label':isBookmarkBlock(location.block)?'blocks.bookmark':location.block.type==='breadcrumb'?'blocks.breadcrumb':'blocks.tableOfContents',[node('div',{class:'block-action-list'},[
  ...(isAttachmentBlock(location.block)?[button('layout.attachment',()=>openAttachmentLayout(blockId),{disabled:!!room&&!room.client?.supportsFeature('block-layout')})]:[]),
  button('blocks.duplicate',()=>duplicateBlocks([blockId]),{disabled:!!room}),button('blocks.copyLink',()=>void copyBlockLink(blockId)),button('moveUp',()=>move(-1),{disabled:!!room||location.index===0}),button('moveDown',()=>move(1),{disabled:!!room||location.index===location.siblings.length-1}),button('blockMove.inPage',()=>openInPageBlockMove(blockId)),button('moveBlockToPage',()=>void openBlockMove(blockId),{disabled:!canTransferSelection(blockId)}),button('deleteBlock',()=>deleteNestedBlock(blockId))])],{motionKind:'menu'});
}
function openAttachmentLayout(blockId){
 const block=blockLocation(blockId)?.block,scope=blockDragScope();if(!isAttachmentBlock(block)||structureDisabled())return;
 const data=block.data.layout??{width:100,align:'left'},width=node('input',{type:'number',min:15,max:100,step:1,value:data.width,'aria-label':t('layout.attachmentWidth')}),align=node('select',{'aria-label':t('layout.alignment')},['left','center','right'].map(value=>node('option',{value},t('layout.'+value))));align.value=data.align;const feedback=node('p',{role:'status',class:'hint'});
 const save=button('layout.apply',()=>{const value={width:Number(width.value),align:align.value};if(scope!==blockDragScope()||blockLocation(blockId)?.block!==block||!validAttachmentLayout(value)){feedback.textContent=t('layout.invalid');return;}if(applyBlockLayout(blockId,'layout',value,{kind:'attachment-layout',blockId,layout:value})){const figure=document.getElementById('block-'+blockId)?.querySelector('.attachment-block');if(figure){figure.style.setProperty('--attachment-width',value.width+'%');figure.dataset.align=value.align;}modal.close();}},{primary:true});
 showModal('layout.attachment',[node('label',{class:'field'},[t('layout.attachmentWidth'),width]),node('label',{class:'field'},[t('layout.alignment'),align]),node('p',{class:'hint'},t('layout.attachmentHint')),feedback,node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),save])]);width.focus();
}
function openDatabaseActions(blockId,envelope){
 const block=blockLocation(blockId)?.block;if(!isDatabaseBlock(block))return;const disabled=structureDisabled()||state.conflict||!!bodySaveBlocked;
 showModal('layout.databaseActions',[node('div',{class:'block-action-list'},[
  button('layout.database',()=>openDatabaseLayout(blockId),{disabled:disabled||!!room&&!room.client?.supportsFeature('block-layout')}),
  button('inlineDatabase.settings',()=>void openDatabaseSettings(blockId,envelope),{disabled:disabled||!!room}),
  node('a',{class:'button',href:'/collections?'+new URLSearchParams({workspace:workspaceId,collection:block.data.collectionId}),target:'_blank',rel:'noopener'},t('layout.fullDatabase')),
  button('blocks.copyLink',()=>void copyBlockLink(blockId)),button('blocks.duplicate',()=>duplicateBlocks([blockId]),{disabled:disabled||!!room}),
  button('blockMove.inPage',()=>openInPageBlockMove(blockId),{disabled}),button('deleteBlock',()=>deleteNestedBlock(blockId),{disabled})
 ])],{motionKind:'menu'});
}
function openDatabaseLayout(blockId){
 const block=blockLocation(blockId)?.block,scope=blockDragScope();if(!isDatabaseBlock(block)||structureDisabled())return;
 const data=block.data.presentation??{},title=node('input',{type:'text',maxLength:240,value:data.title??'','aria-label':t('layout.databaseTitle'),placeholder:t('layout.sourceTitle')}),symbol=node('input',{type:'text',maxLength:32,value:data.icon??'','aria-label':t('layout.databaseIcon')}),height=node('input',{type:'number',min:200,max:1200,step:1,value:data.height??480,'aria-label':t('layout.databaseHeight')}),visible=node('input',{type:'checkbox',checked:data.showTitle!==false}),feedback=node('p',{class:'hint',role:'status'});
 const save=button('layout.apply',()=>{const value={title:title.value,icon:symbol.value,showTitle:visible.checked,height:Number(height.value)};if(scope!==blockDragScope()||blockLocation(blockId)?.block!==block||!validDatabasePresentation(value)){feedback.textContent=t('layout.invalid');return;}if(applyBlockLayout(blockId,'presentation',value,{kind:'database-presentation',blockId,presentation:value})){databasePlacements.get(blockId)?.updatePresentation();modal.close();}},{primary:true});
 showModal('layout.database',[node('div',{class:'database-layout-fields'},[node('label',{class:'field'},[t('layout.databaseTitle'),title]),node('label',{class:'field'},[t('layout.databaseIcon'),symbol]),node('label',{class:'check-field'},[visible,t('layout.showTitle')]),node('label',{class:'field'},[t('layout.databaseHeight'),height])]),node('p',{class:'hint'},t('layout.localDatabase')),feedback,node('div',{class:'dialog-actions'},[button('cancel',()=>modal.close()),save])]);title.focus();
}
function blockDragScope() {return state.current&&state.user?JSON.stringify([state.user.id,workspaceId,state.current.page.id,state.selection]):null;}
function canDragBlock(blockId) {
 return !!state.draft&&!resizingLayout&&!draggedPageId&&!modalOpen()&&!structureDisabled()&&!state.conflict&&!bodySaveBlocked&&!wideBlockSelection()&&(!room||room.client?.supportsFeature('content-blocks')||TEXT_BLOCK_TYPES.includes(blockLocation(blockId)?.block.type)||['divider','columns'].includes(blockLocation(blockId)?.block.type))&&canEditNestedBlock(blockLocation(blockId));
}
function arrangeBeside(operation){
 const command={kind:'columns-arrange',blockIds:operation.blockIds??[operation.blockId],targetId:operation.targetId,side:operation.placement,groupId:crypto.randomUUID(),columnIds:[crypto.randomUUID(),crypto.randomUUID()]};
 const result=arrangeBlockColumns(state.draft.blocks,command);rememberEditorSelection();
 if(room){state.draft=clone(room.client.operation(command));presence.changed();updateDirty();render();requestAnimationFrame(()=>[...app.querySelectorAll('[data-block-drag-handle]')].find(handle=>handle.closest('[data-block-id]')?.dataset.blockId===command.blockIds[0])?.focus({preventScroll:true}));}
 else finishTreeChange({blocks:result.blocks,focusHandle:command.blockIds[0]});
}
function validBlockPageDrop(pageId) {return !room&&!state.busy&&pageId!==state.current?.page.id&&state.pages.some(page=>page.id===pageId&&page.capabilities.includes('editBody'));}
function commitBlockDrag(operation) {
 if(!canDragBlock(operation.blockId))return false;
 try{
  if(['left','right'].includes(operation.placement)){const before=captureBlockPositions(app);arrangeBeside(operation);queueMicrotask(()=>{if(!signal.aborted)requestMotionSurface('placement',{root:app,before});});return true;}
  if(operation.blockIds){const plan=planEditorBlocksMove(state.draft.blocks,operation);if(!plan.changed)return false;}else createEditorMovePlanner(state.draft.blocks)(operation);
  const before=captureBlockPositions(app),blocks=operation.blockIds?moveEditorBlocksTo(state.draft.blocks,operation):moveEditorBlockTo(state.draft.blocks,operation);rememberEditorSelection();
  finishTreeChange({blocks,roomBlockIds:operation.blockIds??[operation.blockId],focusHandle:operation.blockIds?.[0]||operation.blockId});queueMicrotask(()=>{if(!signal.aborted)requestMotionSurface('placement',{root:app,before});});return true;
 }catch(error){state.error=nestingError(error);refreshPageFeedback();return false;}
}
function openInPageBlockMove(blockId) {
 if(selectedBlockRoots().length>1&&blockCoveredBySelection(blockId)){openSelectedBlockMove();return;}
 if(!structureAllowed(blockId))return;rememberEditorSelection();
 const locations=indexEditorBlocks(state.draft.blocks),movePlan=createEditorMovePlanner(state.draft.blocks),columnPlan=createBlockColumnPlanner(state.draft.blocks),positions=['before','after','inside',...(!room||room.client?.supportsFeature('block-layout')?['left','right']:[])],plan=operation=>['left','right'].includes(operation.placement)?columnPlan({blockIds:[blockId],targetId:operation.targetId,side:operation.placement}):movePlan(operation);
 const targets=[...locations.values()].filter(location=>positions.some(placement=>{try{plan({blockId,targetId:location.block.id,placement});return true;}catch{return false;}}));
 const label=location=>t('blockMove.targetLabel',{number:location.order+1,text:columnsTargetText(location).slice(0,80)});
 const target=node('select',{'aria-label':t('blockMove.target')},[node('option',{value:''},t('blockMove.end')),...targets.map(location=>node('option',{value:location.block.id,translate:'no'},label(location)))]);
 const position=node('select',{'aria-label':t('blockMove.position')});
 const current=state.draft,selection=state.selection,status=node('p',{class:'hint',role:'status'});
 const move=button('blockMove.apply',()=>{
  if(current!==state.draft || selection!==state.selection || !structureAllowed(blockId))return;
  const operation={blockId,targetId:target.value||null,placement:target.value?position.value:'end'};
  try{plan(operation);if(['left','right'].includes(operation.placement)){modal.close();arrangeBeside(operation);return;}const blocks=moveEditorBlockTo(state.draft.blocks,operation);rememberEditorSelection();modal.close();finishTreeChange({blocks,roomBlockIds:[blockId],...(blockLocation(blockId)?.block.type==='columns'?{focusHandle:blockId}:{focus:{blockId,start:0}})});}catch(error){status.textContent=t(nestingError(error));}
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
 const scope=collectionScope();await closeModalFully();await autosave.flush();await settleBodySave();
 if(scope!==collectionScope()||state.dirty||state.conflict||bodySaveBlocked)return;
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
    const data=await request(basePath()+'?context=1');
    if (marker !== state.listGeneration) return;
    if (data.workspaceId !== workspaceId || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
        !['owner', 'admin', 'member', 'guest'].includes(data.role) || !Array.isArray(data.pages) ||
        data.pages.some(page => !validId(page.id) || page.workspaceId !== workspaceId || typeof page.title !== 'string' || !Array.isArray(page.capabilities) || !page.capabilities.includes('read'))) throw new ApiError(0, 'INVALID_RESPONSE');
    applyLiveDirectory(data);
    if (announce) { state.notice = 'listRefreshed'; state.error = ''; }
    return true;
  } catch (error) { if (marker === state.listGeneration) state.error = errorKey(error, 'listFailed'); return false; }
  finally { if (marker === state.listGeneration) { state.listLoading = false; if(state.current&&!state.loading){paintChrome();refreshSaveStatus();refreshChildPages();}else render(); } }
}
function cancelPagePrefetch(){clearTimeout(prefetchTimer);prefetchTimer=null;}
function prefetchPage(pageId){
 cancelPagePrefetch();if(!state.user||state.fatal||state.busy||state.dirty||room||pageId===state.current?.page.id||!validId(pageId))return;
 prefetchTimer=setTimeout(()=>{prefetchTimer=null;void pageReads.load(pageId,{prefetch:true}).catch(()=>{});},100);
}
function rememberPagePosition(){const scroll=app.querySelector('.workspace-scroll');if(state.current&&!state.loading&&scroll){pageReads.remember(state.current.page.id,state.current);pagePositions.delete(state.current.page.id);pagePositions.set(state.current.page.id,{top:scroll.scrollTop,left:scroll.scrollLeft});if(pagePositions.size>30)pagePositions.delete(pagePositions.keys().next().value);}}
function pageHistory(pageId,{historyMode='push',hash='',viewId=null}={}){
 if(historyMode==='none')return;const url=new URL(location.href);if(pageId)url.searchParams.set('page',pageId);else url.searchParams.delete('page');url.searchParams.delete('view');if(viewId)url.searchParams.set('view',viewId);url.hash=hash;
 const page=state.pages.find(page=>page.id===pageId);if(page)workspaceBrand?.apply({titleSuffix:'',pageTitle:page.title||t('untitled')});
 if(url.href!==location.href)history[historyMode==='replace'?'replaceState':'pushState'](null,'',url);
}
async function selectPage(pageId, reload = false, discardConfirmed = false, ownsView = null, route = {}) {
  if(state.busy||!validId(pageId))return;
  if(!reload&&!state.loading&&state.current?.page.id===pageId){if(route.hash){pageHistory(pageId,route);try{document.getElementById(decodeURIComponent(route.hash.slice(1)))?.scrollIntoView({block:'center'});}catch{}}return;}
  if(reload)route={hash:location.hash,viewId:collectionViewId,...route};
  const intent=++pageIntent,started=performance.now();
  await settleBodySave();
  if(intent!==pageIntent||ownsView&&!ownsView())return;
  if (state.busy || !validId(pageId) || (!reload && state.current?.page.id === pageId)) return;
  if(!discardConfirmed){const preparation=navigationPreparation??=confirmReplace(reload);let accepted;try{accepted=await preparation;}finally{if(navigationPreparation===preparation)navigationPreparation=null;}if(!accepted)return;}
  if(intent!==pageIntent||ownsView&&!ownsView())return;
  rememberPagePosition();cancelPagePrefetch();placementUiStates.clear();
  if(state.current&&state.current.page.id!==pageId){collectionViewId=null;collectionRecovery=false;collectionRefresh=false;}
  destroyRoom();
  const marker = ++state.selection;
  pageController?.abort(); pageController = new AbortController();
  const preview=reload?null:pageReads.preview(pageId);
  if(route.viewId!==undefined)collectionViewId=route.viewId;
  state.current=preview;state.draft=preview?{title:preview.page.title,blocks:clone(preview.document.blocks)}:null;editorHistory=null;state.collection=null;state.collectionError='';state.recordError='';state.people=[];state.dirty=false;state.conflict=false;state.locked=false;
  state.pendingPageId=pageId;state.loading = true; state.error = ''; state.notice = '';state.navOpen=false;pageHistory(pageId,{...route,historyMode:route.historyMode??(reload?'replace':'push')});if(!route.initialPage)render();
  try {
    if(route.initialError)throw new ApiError(route.initialError.status,route.initialError.code);
    const data = route.initialPage?validatePageEnvelope(route.initialPage,pageId):await pageReads.load(pageId,{signal:pageController.signal});
    if(data.context&&data.context.accountId!==state.user?.id)throw new ApiError(404,'CONTENT_NOT_FOUND');
    if (marker !== state.selection) return;
    if(detailMode&&detailTarget.get('synced')!=='1'&&(data.page.collectionId!==detailTarget.get('collection')||data.page.recordId!==detailTarget.get('record')))throw new ApiError(404,'CONTENT_NOT_FOUND');
    let collection = null, collectionError = '', people = [];
    if (validId(data.page.collectionId)) {
      try {
        const value = data.context?data.context.collection:await request(collectionPath(data.page.collectionId), { signal: pageController.signal });
        collection = new CollectionEdits(value, { workspaceId, collectionId: data.page.collectionId });
        const currentRecord=data.page.recordId?collection.record(data.page.recordId):null;
        if(collection.revision!==data.revision || currentRecord&&(currentRecord.pageId!==pageId || currentRecord.title!==data.page.title))throw new ApiError(409,'COLLECTION_READ_CHANGED');
        if(collection.collection.properties.some(property=>property.type==='person')) {
          const containerId=collection.envelope.pageId;
          try {
            const candidates=Array.isArray(data.context?.people)?{pageId:containerId,people:data.context.people}:await request(basePath()+'/'+encodeURIComponent(containerId)+'/people',{signal:pageController.signal});
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
    persistSidebarDisclosure();
    state.current = data; state.draft = { title: data.page.title, blocks: clone(data.document.blocks) };
    initialPlacements=new Map(Object.entries(data.context?.placements??{}));initialSynced=new Map(Object.entries(data.context?.synced??{}));
    editorHistory=new EditorHistory(state.draft);
    state.dirty = false; state.conflict = false; state.locked = false; state.listRevision = data.revision;
    bodySaveBlocked='';appearanceDraft=null;observedDraft=draftSignature();draftGeneration++;autosave.reset();
    state.navOpen = false;
    const found = state.pages.findIndex(page => page.id === pageId); if (found >= 0) state.pages[found] = data.page;
  } catch (error) { if (marker === state.selection && !pageController.signal.aborted) {state.error=errorKey(error,'loadFailed');state.current=null;state.draft=null;state.collection=null;editorHistory=null;} }
  finally { if (marker === state.selection) { state.loading = false;state.pendingPageId=null;render();const position=pagePositions.get(pageId);await placementsReady();requestAnimationFrame(()=>{if(marker!==state.selection)return;app.dataset.pageReadyMs=String(Math.round(performance.now()-started));const scroll=app.querySelector('.workspace-scroll');if(scroll){scroll.scrollTop=position?.top||0;scroll.scrollLeft=position?.left||0;}if(route.hash){let target;try{target=document.getElementById(decodeURIComponent(route.hash.slice(1)));}catch{}target?.scrollIntoView({block:'center'});}else if(route.focusTitle)focusContent();}); } }
  if(detailMode&&detailTarget.get('synced')==='1'&&state.current?.page.id===pageId&&canEdit()&&!room)queueMicrotask(()=>void startRoom());
}
async function reloadPage() { if (state.current) await selectPage(state.current.page.id, true); }
async function persistDraft(context){
  const task=(async()=>{
    if(!room&&bodyDirty()){const result=await persistPage(context);if(result.status!=='saved')return result;}
    const model=state.collection;
    for(const record of model?.collection.records??[]){
      if(!context.isCurrent()||state.collection!==model)return {status:'paused'};
      if(model.dirtyPropertyIds(record.id).length){const result=await persistRecord(record.id,context);if(result.status!=='saved')return result;}
    }
    if(appearanceDraft){const result=await persistAppearance(context);if(result.status!=='saved')return result;}
    return {status:'saved'};
  })();
  bodySaveTask=task;refreshSaveStatus();
  try{return await task;}finally{
    if(bodySaveTask===task){bodySaveTask=null;recordWriteActive=false;}
    if(context.isCurrent()){updateDirty();refreshRecordFeedback();refreshPageFeedback();refreshCollectionAfterEditing();if(room?.needsSync)queueRoomSync(room);}
  }
}
async function persistPage({isCurrent}) {
  if(room||editingDisabled()||roomCompositions.size||autosaveModalBlocked()||state.conflict||bodySaveBlocked||draggedBlockId||resizingLayout||!bodyDirty())return {status:'paused'};
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
      const label=app.querySelector('.page-list [aria-current="page"] [data-sidebar-page-title]');if(label)label.textContent=data.page.title;
      const version=app.querySelector('[data-document-version]');if(version)version.textContent=t('version',{version:data.document.version});
      return {status:state.conflict?'conflict':'saved'};
    }catch(error){
      if(!current())return {status:'paused'};
      if(error.status===409){state.conflict=true;state.error='conflict';return {status:'conflict'};}
      if([400,401,403,404,413].includes(error.status)){state.error=errorKey(error,'saveFailed');bodySaveBlocked='rejected';return {status:'rejected'};}
      bodySaveBlocked='unknown';state.error='saveUnknown';return {status:'unknown'};
    }
  })();
  return task;
}
async function openCreate(teamspaceId=null,parentId=null) {
  const restoreFocus=capturePageCreatorFocus({document,root:app});
  if (room || !state.user || state.busy || state.listLoading || state.role === 'guest' || state.locked || state.fatal || !await confirmReplace()) return;
  const team=teamspaceId?state.teamspaces.find(item=>item.id===teamspaceId&&item.capabilities.includes('createPage')&&!item.archivedAt):null;
  if(teamspaceId&&!team)return;
  const parent=parentId?state.pages.find(item=>item.id===parentId&&canManagePage(item)):null;
  if(parentId&&!parent)return;
  await closeModalFully();
  const accountId=state.user.id,selection=state.selection,controller=new AbortController();
  const destinations=pageCreationDestinations({pages:state.pages,teamspaces:state.teamspaces,t,canManage:canManagePage});
  const creator=createPageCreator({document,t,destinations,initialDestination:parent?'page:'+parent.id:team?'team:'+team.id:'private',
    personalHref:'/templates?'+new URLSearchParams({workspace:workspaceId}),
    loadPersonalList:()=>request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/templates',{signal:controller.signal}),
    loadPersonalItem:id=>request('/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/templates/'+encodeURIComponent(id),{signal:controller.signal}),
    onCreate:async value=>{if(state.user?.id!==accountId||controller.signal.aborted)return{blocked:true};return createPage(value.title,value.teamspaceId,value.parentId,value.snapshot,value.observedRevision,value.starter);}});
  showModal('createPage',creator.root);creator.focus();
  modal.addEventListener('close',()=>{creator.destroy();controller.abort();if(state.selection===selection)restoreFocus(modal);},{once:true});
}
async function createPage(title,teamspaceId=null,parentId=null,snapshot=null,observedRevision=null,starter=null) {
  if(!await settleBodySave())return;
  if (room || state.busy || state.listLoading || state.locked || state.fatal || !state.user || state.role==='guest') return{blocked:state.locked||!!state.fatal};
  state.busy = true; state.error = ''; state.notice = '';
  for (const control of modal.querySelectorAll('button,input,select')) control.disabled = true;
  render();
  const accountId=state.user?.id,selection=state.selection,previousPageId=state.current?.page.id,generation=draftGeneration;
  const ownsView=()=>state.user?.id===accountId&&state.selection===selection&&state.current?.page.id===previousPageId&&draftGeneration===generation;
  let createdId,acknowledged=false;
  try {
    const parent=parentId?state.pages.find(page=>page.id===parentId&&canManagePage(page)):null;
    if(parentId&&!parent)throw new ApiError(404,'CONTENT_NOT_FOUND');
    // Template reads can observe a newer workspace revision after saving a template in another tab.
    // Creation changes no existing document; the server still checks current destination permissions.
    const expectedRevision=Math.max(state.listRevision,observedRevision??0);
    const submitted={expectedRevision,title,...(starter?{starter}:{blocks:snapshot?instantiatePageStarter(snapshot):[{id:crypto.randomUUID(),type:'paragraph',data:{text:''}}]}),...(parentId?{parentId}:teamspaceId?{teamspaceId}:{})};
    const data=validateCreatedPage(submitted,await request(basePath(),{method:'POST',body:submitted}),{workspaceId});
    acknowledged=true;if(!ownsView())return;
    validateCreatedPageProjection(data,validatePageEnvelope(await request(basePath()+'/'+encodeURIComponent(data.page.id)),data.page.id),{workspaceId,teamspaceId:parent?.teamspaceId??teamspaceId});
    if(!ownsView())return;
    createdId = data.page.id; state.listRevision = data.revision;if(parentId)expandedSidebarPages.add(parentId);
    // Only a successful creation replaces the previous tab draft.
    modal.close(); state.notice = 'created';
  } catch (error) {
    if(!ownsView())return;
    const unknown=acknowledged||error.status===0||error.status>=500||error.code==='INVALID_CREATE_RESPONSE';
    state.error = unknown?'teamspaces.createUnknown':error.status === 409 ? 'createConflict' : errorKey(error, 'createFailed');
    if(unknown){state.locked=true;bodySaveBlocked='unknown';for(const control of modal.querySelectorAll('.dialog-header button,.create-form button[type="button"]'))control.disabled=false;}
    else for (const control of modal.querySelectorAll('button,input,select')) control.disabled = false;
    const message = modal.querySelector('.create-feedback'); if (message) { message.textContent = t(state.error); message.setAttribute('role', 'alert'); }
  } finally { state.busy = false; render(); }
  if (createdId&&ownsView()) { if(!await refreshList()||!ownsView())return;await selectPage(createdId, false, true,ownsView);if(state.user?.id===accountId&&state.current?.page.id===createdId&&state.draft.blocks[0])focusBlock((state.draft.blocks.find(block=>block.type==='paragraph'&&block.data?.text==='')??state.draft.blocks[0]).id); }
  return{blocked:state.locked||!!state.fatal};
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
async function createSubpage(pageId){
 const page=state.pages.find(item=>item.id===pageId);
 if(!canManagePage(page)||room||state.busy||state.listLoading)return;
 await openCreate(null,page.id);
}
function refreshChildPages(root=app){
 const host=root.querySelector('[data-child-pages]');if(!host||!state.current)return;
 const children=state.pages.filter(page=>page.parentId===state.current.page.id);
 const links=children.map(page=>node('a',{class:'child-page-link',href:'/workspace?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),onClick:event=>{if(event.button||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;event.preventDefault();void selectPage(page.id);},onPointerEnter:()=>prefetchPage(page.id),onPointerLeave:cancelPagePrefetch},[icon(page.collectionId?'table':'page'),node('span',{translate:'no'},page.title||t('untitled'))]));
 if(canManagePage(state.current.page)&&!room)links.push(button('pageTree.addChild',()=>void createSubpage(state.current.page.id),{class:'child-page-link child-page-create',icon:'plus',disabled:state.busy||state.listLoading}));
 host.replaceChildren(...links);host.hidden=!links.length;
}
async function reorderSidebarPage(page,placement){
 if(state.busy||state.listLoading||!canManagePage(page)||!await settleBodySave())return;
 const accountId=state.user?.id,scope=collectionScope();state.busy=true;state.error='';paintChrome();
 try{
  const expectedRevision=state.listRevision,result=await request(basePath()+'/'+encodeURIComponent(page.id)+'/location',{method:'PATCH',body:{expectedRevision,parentId:placement.parentId,beforeId:placement.beforeId}});
  if(result?.pageId!==page.id||result.revision!==expectedRevision+1||result.reordered!==true)throw new ApiError(0,'INVALID_RESPONSE');
  if(scope===collectionScope()&&state.current?.revision===expectedRevision){state.collection?.advanceNavigationBasis({expectedRevision,revision:result.revision});state.current.revision=result.revision;}
  const fresh=await request(basePath());if(state.user?.id!==accountId||signal.aborted)return;
  if(fresh.workspaceId!==workspaceId||!Number.isSafeInteger(fresh.revision)||fresh.revision<result.revision||!Array.isArray(fresh.pages)||fresh.pages.some(item=>!validId(item.id)||item.workspaceId!==workspaceId||typeof item.title!=='string'||!Array.isArray(item.capabilities)||!item.capabilities.includes('read')))throw new ApiError(0,'INVALID_RESPONSE');
  state.pages=fresh.pages;state.listRevision=fresh.revision;pageReads.clear();state.notice='pageTree.reordered';
  if(state.current&&!fresh.pages.some(item=>item.id===state.current.page.id)){state.locked=true;state.error='operationAccessChanged';}
  refreshChildPages();
 }catch(error){state.error=operationError(error);}
 finally{state.busy=false;paintChrome();refreshPageFeedback();autosave.refresh();}
}
function moveSidebarPage(pageId,direction){
 const page=state.pages.find(item=>item.id===pageId),siblings=sidebarSiblings(state.pages,pageId),index=siblings.findIndex(item=>item.id===pageId);
 if(!page||index<0||direction==='up'&&index===0||direction==='down'&&index===siblings.length-1)return;
 void reorderSidebarPage(page,{parentId:page.parentId,beforeId:direction==='up'?siblings[index-1].id:siblings[index+2]?.id??null});
}
function openSidebarPageMove(pageId){const page=state.pages.find(item=>item.id===pageId);if(page)openPageOperation('move',page);}
function openSidebarPageTrash(pageId){const page=state.pages.find(item=>item.id===pageId);if(page)openPageOperation('trash',page);}
async function openSidebarTeamspaceMove(pageId){if(room||state.busy||state.loading||!await confirmReplace())return;await closeModalFully();if(state.current?.page.id!==pageId)await selectPage(pageId);if(state.current?.page.id===pageId)await openPageTeamspaceMove(state.current.page);}
function openCreateTeamspace(){void openSettings('teamspaces',null,null,true);}
function startPageDrag(event,page) {
  if(draggedBlockId || !canManagePage(page) || page.recordId || page.templateId || state.busy) { event.preventDefault(); return; }
  draggedPageId=page.id; event.dataTransfer.setData('application/x-yumunio-page',page.id); event.dataTransfer.effectAllowed='move'; app.classList.add('page-dragging');
}
function endPageDrag() { draggedPageId=null; app.classList.remove('page-dragging'); for(const item of app.querySelectorAll('[data-page-drop]'))delete item.dataset.pageDrop; }
function pageDrop(event,targetId){
 const source=state.pages.find(page=>page.id===draggedPageId);if(!source)return null;
 if(targetId===null)return !room&&!source.teamspaceId?{parentId:null,beforeId:null}:null;
 const rect=event.currentTarget.getBoundingClientRect(),ratio=(event.clientY-rect.top)/Math.max(1,rect.height),edge=ratio<.25?'before':ratio>.75?'after':'inside';
 const placement=sidebarDropPlacement(state.pages,source.id,targetId,edge);if(!placement||room&&placement.parentId!==source.parentId)return null;return{...placement,edge};
}
function overPageDrop(event,targetId) { const placement=pageDrop(event,targetId);if(!placement)return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';for(const item of app.querySelectorAll('[data-page-drop]'))delete item.dataset.pageDrop;event.currentTarget.dataset.pageDrop=placement.edge??'inside'; }
function dropPage(event,targetId) { const placement=pageDrop(event,targetId);if(!placement||event.dataTransfer.getData('application/x-yumunio-page')!==draggedPageId)return;event.preventDefault();event.stopPropagation();const page=state.pages.find(item=>item.id===draggedPageId);endPageDrag();if(placement.parentId===page.parentId)void reorderSidebarPage(page,placement);else openPageOperation('move',page,placement.parentId,placement.beforeId); }
async function openPageAppearance(){
 if(!state.current?.page.capabilities.includes('editBody')||room||state.busy||state.locked)return;
 const scope=blockDragScope();await closeModalFully();await autosave.flush();await settleBodySave();
 if(scope!==blockDragScope()||state.conflict||bodySaveBlocked||state.collection?.dirty)return;
 const appearance=appearanceDraft??state.current.page.appearance??defaultPageAppearance();
 const iconInput=node('input',{type:'text',maxLength:32,value:appearance.icon,'aria-label':t('blocks.icon'),placeholder:'📄'});
 const cover=node('select',{'aria-label':t('pageTools.cover')},[node('option',{value:''},t('pageTools.noCover')),...(state.current.attachments??[]).filter(asset=>['image/png','image/jpeg','image/gif','image/webp'].includes(asset.mediaType)).map(asset=>node('option',{value:asset.id,translate:'no'},asset.name))]);cover.value=appearance.coverAttachmentId??'';
 const fields=['fullWidth','smallText','locked'].map(key=>({key,input:node('input',{type:'checkbox',checked:appearance[key]})})),message=node('p',{role:'alert'});
 const changed=()=>{
  if(scope!==blockDragScope())return;
  try{
   const value=validatePageAppearance({icon:iconInput.value,coverAttachmentId:cover.value||null,...Object.fromEntries(fields.map(({key,input})=>[key,input.checked]))});
   const original=state.current.page.appearance??defaultPageAppearance();
   appearanceDraft=Object.keys(value).every(key=>value[key]===original[key])&&!bodySaveTask?null:value;
   message.textContent='';updateDirty();
  }catch{message.textContent=t('pageTools.invalid');}
 };
 for(const input of [iconInput,cover,...fields.map(field=>field.input)])input.addEventListener('input',changed);
 iconInput.addEventListener('compositionstart',()=>{roomCompositions.add(iconInput);autosave.refresh();});
 iconInput.addEventListener('compositionend',()=>{roomCompositions.delete(iconInput);changed();});
 showModal('pageTools.appearance',[
  node('label',{class:'field'},[t('blocks.icon'),iconInput]),node('label',{class:'field'},[t('pageTools.cover'),cover]),node('p',{class:'hint'},t('pageTools.coverHint')),
  ...fields.map(({key,input})=>node('label',{class:'checkbox-label'},[input,t('pageTools.'+(key==='locked'?'lock':key))])),node('p',{class:'hint'},t('pageTools.lockHint')),message
 ],{cancelLabel:'close'});
}
async function persistAppearance({isCurrent}){
 if(!isCurrent()||!appearanceDraft||room)return {status:'paused'};
 const submitted=clone(appearanceDraft),pageId=state.current.page.id,expectedRevision=state.current.revision,expectedVersion=state.current.document.version;
 try{
  const result=await request(basePath()+'/'+encodeURIComponent(pageId)+'/appearance',{method:'PATCH',body:{expectedRevision,expectedVersion,appearance:submitted}});
  if(!isCurrent())return {status:'paused'};
  if(result?.pageId!==pageId||result.revision!==expectedRevision+1||result.version!==expectedVersion+1||Object.entries(validatePageAppearance(result.appearance)).some(([key,value])=>value!==submitted[key]))throw new ApiError(0,'INVALID_RESPONSE');
  state.collection?.advanceDocumentBasis({expectedRevision,revision:result.revision,pageId,title:state.current.page.title});
  state.current.page.appearance=clone(result.appearance);state.current.document.version=result.version;state.current.revision=result.revision;state.listRevision=result.revision;
  const page=state.pages.find(page=>page.id===pageId);if(page)page.appearance=clone(result.appearance);
  if(appearanceDraft&&Object.keys(submitted).every(key=>appearanceDraft[key]===submitted[key]))appearanceDraft=null;
  render();return {status:'saved'};
 }catch(error){
  if(!isCurrent())return {status:'paused'};
  if(error.status===409){state.conflict=true;state.error='conflict';return {status:'conflict'};}
  bodySaveBlocked=[400,401,403,404,413,422].includes(error.status)?'rejected':'unknown';state.error=bodySaveBlocked==='unknown'?'saveUnknown':errorKey(error,'saveFailed');return {status:bodySaveBlocked};
 }
}

function openPageDuplicate(){
 if(!state.current||room||state.busy||state.role==='guest'||state.current.page.collectionId)return;
 const scope=blockDragScope(),title=node('input',{type:'text',maxLength:240,value:(state.current.page.title+' '+t('pageTools.copySuffix')).slice(0,240),'aria-label':t('pageTitle')}),children=node('input',{type:'checkbox',checked:false}),message=node('p',{role:'alert'});
 showModal('pageTools.duplicate',[node('p',{class:'hint'},t('pageTools.privateCopy')),node('label',{class:'field'},[t('pageTitle'),title]),node('label',{class:'checkbox-label'},[children,t('pageTools.includeChildren')]),message,button('pageTools.duplicate',()=>{if(scope!==blockDragScope())return;if(!title.value.trim()){message.textContent=t('titleRequired');return;}void runPageTool('duplicate',{title:title.value,includeChildren:children.checked});},{primary:true})]);
}
async function runPageTool(action,values){
 if(!state.current||room||state.busy||state.loading||state.locked||state.collection?.dirty)return;
 const scope=blockDragScope(),pageId=state.current.page.id,actorId=state.user.id;
 await closeModalFully();await autosave.flush();await settleBodySave();
 if(scope!==blockDragScope()||bodyDirty()||state.conflict||bodySaveBlocked)return;
 const expectedRevision=state.current.revision,expectedVersion=state.current.document.version;state.busy=true;state.error='';render();let destination=null;
 try{
  const result=await request(basePath()+'/'+encodeURIComponent(pageId)+'/'+action,{method:action==='duplicate'?'POST':'PATCH',body:{expectedRevision,expectedVersion,...values}});
  if(scope!==blockDragScope()||state.user?.id!==actorId)return;
  if(result?.revision!==expectedRevision+1||!validId(result.pageId)||action==='appearance'&&(result.pageId!==pageId||result.version!==expectedVersion+1||Object.entries(validatePageAppearance(result.appearance)).some(([key,value])=>value!==values.appearance[key]))||action==='favorite'&&(result.pageId!==pageId||result.version!==expectedVersion||result.favorite!==values.favorite)||action==='duplicate'&&(state.pages.some(page=>page.id===result.pageId)||!Number.isSafeInteger(result.pageCount)||result.pageCount<1))throw new ApiError(0,'INVALID_RESPONSE');
  destination=result.pageId;
 }catch(error){state.error=error.code==='PAGE_COLLECTION_COPY_UNSUPPORTED'?'pageTools.collectionCopy':error.status===409?'operationConflict':errorKey(error,'pageTools.uncertain');}
 finally{state.busy=false;render();}
 if(destination){await refreshList();await selectPage(destination,true,true);if(state.current?.page.id===destination){state.notice=action==='appearance'?'pageTools.saved':action==='favorite'?'pageTools.favoriteSaved':'pageTools.copied';refreshPageFeedback();}}
}
async function openPageActions() {
  if(!state.current||state.busy||!await prepareEditorDialog())return;
  const page=state.current.page, manageable=canManagePage(page);
  showModal('pageActions',[
    node('p',{translate:'no',class:'operation-page-title'},page.title),
    button(page.favorite?'pageTools.removeFavorite':'pageTools.addFavorite',()=>void runPageTool('favorite',{favorite:!page.favorite}),{disabled:!!room||state.locked||state.collection?.dirty}),
    ...(page.capabilities.includes('editBody')?[button('pageTools.appearance',openPageAppearance,{disabled:!!room||state.locked||state.collection?.dirty})]:[]),
    ...(state.role!=='guest'&&!page.collectionId?[button('pageTools.duplicate',openPageDuplicate,{disabled:!!room||state.locked})]:[]),
    node('a',{href:'/share?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pageSharing')),
    node('a',{href:'/comments?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pageComments')),
    ...(page.capabilities?.includes('manage')&&!state.locked?[!room&&!state.dirty?node('a',{href:'/publication?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pagePublication')):button('pagePublication',()=>{},{disabled:true,title:t(room?'publicationStopRoom':'publicationSaveFirst')})]:[]),
    ...(canEdit()?[!room&&!state.dirty?node('a',{href:'/attachments?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pageAttachments')):button('pageAttachments',()=>{},{disabled:true,title:t(room?'attachmentStopRoom':'attachmentSaveFirst')})]:[]),
    ...(validId(page.collectionId)?[node('a',{href:'/collections?workspace='+encodeURIComponent(workspaceId)+'&collection='+encodeURIComponent(page.collectionId),class:'button'},t('openCollection'))]:[]),
    ...(manageable?[node('a',{href:'/history?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(page.id),class:'button'},t('pageHistory'))]:[]),
    button('movePage',()=>openPageOperation('move',page),{icon:'arrow',disabled:!!room || !manageable || !!page.recordId,title:t(room?'roomStopFirst':page.recordId?'recordCannotMove':'manageRequired')}),
    button('teamspaces.movePage',()=>void openPageTeamspaceMove(page),{icon:'account',disabled:!!room||!manageable||!!page.recordId||state.dirty,title:t(room?'roomStopFirst':'teamspaces.saveBeforeMove')}),
    button('trashPage',()=>openPageOperation('trash',page),{icon:'trash',disabled:!!room || !manageable,title:t(room?'roomStopFirst':'manageRequired')}),
    node('p',{class:'hint'},t(page.recordId?'recordCannotMove':'pageOperationHint'))
  ]);
}
function openPageOperation(action,page,parentId,beforeId=undefined) {
  if(room || state.busy || !page || (action==='restore'?!page.capabilities?.includes('restore'):!canManagePage(page)))return;
  operation={action,page,beforeId,parent:parentId===undefined?(action==='restore'?'previous':page.parentId??(page.teamspaceId?'@team-root':'')):parentId??'',inherit:false,revision:action==='restore'?page.trashRevision:state.listRevision,pending:false,error:'',recheck:false,unavailable:false};
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
    ...(op.action==='restore'?[node('option',{value:'previous'},t('previousLocation'))]:[]),node('option',{value:op.page.teamspaceId&&op.action==='move'?'@team-root':''},t(op.page.teamspaceId&&op.action==='move'?'pageTree.teamspaceRoot':'workspaceTop')),
    ...targets.map(page=>node('option',{value:page.id,translate:'no'},page.title))
  ]);
  parent.value=op.parent;if(parent.value!==op.parent) {op.parent=op.action==='restore'?'previous':op.page.teamspaceId?'@team-root':'';parent.value=op.parent;}
  parent.addEventListener('change',()=> {op.parent=parent.value;op.beforeId=undefined;op.inherit=false;renderPageOperation();});
  const inherit=node('input',{type:'checkbox',checked:op.inherit,disabled:!op.parent||op.parent==='@team-root'}); inherit.addEventListener('change',()=>op.inherit=inherit.checked);
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
    op.inherit=false;op.beforeId=undefined;op.error='operationReviewed';op.recheck=false;
  }catch(error){op.error=operationError(error);}finally{op.pending=false;renderPageOperation();}
}
function clearCurrentPage() {collectionView?.destroy();collectionView=null;collectionViewId=null;collectionRecovery=false;collectionRefresh=false;editorHistory=null;state.current=null;state.draft=null;state.collection=null;state.collectionError='';state.recordError='';state.people=[];state.dirty=false;state.conflict=false;const url=new URL(location.href);url.searchParams.delete('page');url.searchParams.delete('view');url.hash='';history.replaceState(null,'',url);}
async function executePageOperation() {
  if(!await settleBodySave())return;
  const op=operation;if(!op || op.pending || op.recheck || op.unavailable || state.busy)return;
  if(op.action==='move'&&op.parent==='@team-root'){operation=null;await closeModalFully();await openSidebarTeamspaceMove(op.page.id);return;}
  if(!await confirmReplace()) {renderPageOperation();return;}
  op.pending=true;state.busy=true;renderPageOperation();render();
  try {
    const suffix=op.action==='move'?'/location':op.action==='restore'?'/restore':'';
    const body={expectedRevision:op.revision,...(op.action==='trash'?{}:{...(op.parent==='previous'?{}:{parentId:op.parent||null}),inheritPermissions:op.inherit===true,...(op.action==='move'&&op.beforeId!==undefined?{beforeId:op.beforeId}:{})})};
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
async function openSearch() {
  if(state.busy||!state.user||!await prepareEditorDialog())return;searchController?.abort();searchGeneration++;
  const input=node('input',{type:'search',id:'page-search',value:searchQuery,maxlength:'100',autocomplete:'off','aria-label':t('searchQuery'),role:'combobox','aria-autocomplete':'list','aria-expanded':'true','aria-controls':'page-search-results'});
  const results=node('div',{class:'search-results',id:'page-search-results',role:'listbox','aria-label':t('searchPages')});
  const submit=node('button',{type:'submit',class:'button primary'},t('searchPages'));
  const form=node('form',{class:'workspace-search-form'},[node('label',{class:'field',for:'page-search'},[t('searchQuery'),input]),submit]);
  let timer;const local=()=>{searchQuery=input.value;searchResults={results:matchingPageTitles(state.pages,searchQuery),truncated:false};renderSearchResults(results);};
  const cancel=()=>{clearTimeout(timer);searchController?.abort();searchGeneration++;submit.disabled=false;results.setAttribute('aria-busy','false');};
  input.addEventListener('input',()=>{cancel();local();if(input.value.trim())timer=setTimeout(()=>void searchPages(input.value,results,submit),180);});
  input.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();modal.close();return;}const options=[...results.querySelectorAll('[role=option]')];if(!options.length)return;let index=Number(results.dataset.activeIndex||0);if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();index=(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;results.dataset.activeIndex=String(index);options.forEach((option,i)=>option.setAttribute('aria-selected',String(i===index)));input.setAttribute('aria-activedescendant',options[index].id);options[index].scrollIntoView({block:'nearest'});}else if(event.key==='Enter'){event.preventDefault();options[index]?.click();}});
  form.addEventListener('submit',event=>{event.preventDefault();clearTimeout(timer);void searchPages(input.value,results,submit);});
  showModal('searchPages',[form,node('p',{class:'hint'},t('searchScope')),results,node('p',{class:'hint search-keyboard-hint'},t('searchKeyboardHint'))]);local();input.focus();
  modal.addEventListener('close',cancel,{once:true});
}
function renderSearchResults(container,{keepSelection=false}={}) {
  if(!searchResults){container.replaceChildren();return;}
  const selected=keepSelection?container.querySelector('[aria-selected=true]')?.dataset.searchPageId:null,activeIndex=Math.max(0,searchResults.results.findIndex(result=>result.page.id===selected));container.dataset.activeIndex=String(activeIndex);
  const list=node('ul',{class:'search-result-list',role:'presentation'},searchResults.results.map((result,index)=>node('li',{role:'presentation'},node('button',{type:'button',id:'page-search-option-'+index,'data-search-page-id':result.page.id,role:'option','aria-selected':String(index===activeIndex),tabindex:'-1',class:'search-result',onPointerEnter:()=>prefetchPage(result.page.id),onClick:async()=>{await closeModalFully();await selectPage(result.page.id);}},[node('strong',{translate:'no'},result.page.title),...(result.snippet?[node('span',{translate:'no'},result.snippet)]:[])]))));
  container.replaceChildren(searchResults.results.length?list:node('p',{},t('searchEmpty')),...(searchResults.truncated?[node('p',{class:'hint'},t('searchTruncated'))]:[]));
  const input=document.getElementById('page-search');if(searchResults.results.length)input?.setAttribute('aria-activedescendant','page-search-option-'+activeIndex);else input?.removeAttribute('aria-activedescendant');
}
async function searchPages(query,container,submit) {
  if(!query.trim())return;searchQuery=query;const marker=++searchGeneration;searchController?.abort();searchController=new AbortController();submit.disabled=true;container.setAttribute('aria-busy','true');
  try {
    const data=await request(workspaceApi('/search?q='+encodeURIComponent(query)),{signal:searchController.signal});
    if(marker!==searchGeneration)return;
    if(data?.workspaceId!==workspaceId || !Number.isSafeInteger(data.revision) || !Array.isArray(data.results) || typeof data.truncated!=='boolean'||data.results.some(result=>!validId(result.page?.id)||typeof result.page.title!=='string'||typeof result.snippet!=='string'))throw new ApiError(0,'INVALID_RESPONSE');
    const titles=matchingPageTitles(state.pages,query),ids=new Set(titles.map(result=>result.page.id));searchResults={...data,results:[...titles,...data.results.filter(result=>!ids.has(result.page.id))]};if(modal.open && modal.dataset.view==='searchPages')renderSearchResults(container,{keepSelection:true});
  }catch(error){if(marker===searchGeneration && modal.open && modal.dataset.view==='searchPages')container.append(node('p',{role:'status',class:'hint'},t('searchFailed')));}
  finally{if(marker===searchGeneration){submit.disabled=false;container.setAttribute('aria-busy','false');}}
}
async function openExport() {
  if(state.busy||!state.user||!await prepareEditorDialog())return;
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
   if(target.pathname==='/workspace'&&target.searchParams.get('workspace')===workspaceId)return true;
   if(!await confirmReplace()||state.user?.id!==accountId)return false;
   destroyRoom();autosave.stop();state.dirty=false;bodySaveBlocked='';location.assign(target.href);return true;
  },onClose:()=>{workspacePicker=null;autosave.refresh();presence.paint();if(nextSettings){const section=nextSettings;queueMicrotask(()=>{if(state.user?.id===accountId&&!modalOpen())openSettings(section);});}}
 });autosave.refresh();presence.paint();
}
async function refreshPolicyAfterSettings(accountId){
 if(state.user?.id!==accountId)return;
 const marker=state.selection,pageId=state.current?.page.id,baseline=state.current,hadRoom=!!room,held=state.dirty||bodyDirty()||state.collection?.dirty;
 const current=()=>state.user?.id===accountId&&state.selection===marker&&state.current?.page.id===pageId;
 const refresh={accountId,selection:marker,pageId};policyRefresh=refresh;
 try{
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
 }finally{if(policyRefresh===refresh){policyRefresh=null;refreshSaveStatus();refreshPageFeedback();}}
}
async function openWorkspaceHome(route={}){
 if(!state.user||state.busy||modalOpen())return;const actorId=state.user.id,selection=state.selection;
 if(!await confirmReplace()||state.user?.id!==actorId||state.selection!==selection)return;
 rememberPagePosition();pageIntent++;destroyRoom();state.selection++;pageController?.abort();pageController=null;state.loading=false;state.pendingPageId=null;pageHistory(null,route);clearCurrentPage();state.locked=false;bodySaveBlocked='';render();autosave.refresh();
}
function openResourceSharing(){if(!state.current)return;openSettings('members',null,{kind:state.collection&&!state.current.page.recordId?'collection':'page',title:state.current.page.title||t('untitled')});}
async function openSettings(section='appearance',teamspaceId=null,resource=null,createTeamspace=false){
 if(settingsDialog?.open){settingsDialog.requestSection(section);return;}
 if(!state.user||state.fatal||state.busy||roomCompositions.size)return;
 if(modal.open||!await prepareEditorDialog())return;
 blockDnd?.cancel();rememberEditorSelection();
 const accountId=state.user.id,pageId=state.current?.page.id,priorLocale=preferences.snapshot().locale;
 let preferenceTask=Promise.resolve();
 settingsPolicyChanged=false;
 settingsDialog=mountSettingsDialog({background:app,workspaceId,expectedAccountId:accountId,pageId,workspaceName:state.name,accountName:state.user.name,resource,initialSection:section,initialTeamspaceId:teamspaceId,createTeamspace,labels:key=>t('settingsDialog.'+key),
  onPreferencesChanged:()=>{preferenceTask=preferenceTask.then(async()=>{
   if(state.user?.id!==accountId)return;
   preferences=new PreferencesStore({profileId:accountId});
   await Promise.all([i18n.switchLocale(preferences.snapshot().locale),fieldI18n.switchLocale(preferences.snapshot().locale)]);
   if(state.user?.id===accountId)applyPreferences();
  }).catch(()=>{state.error='preferenceFailed';});return preferenceTask;},
  onWorkspaceChanged:()=>{settingsPolicyChanged=true;},
  onClose:()=>{settingsDialog=null;const policyChanged=settingsPolicyChanged;settingsPolicyChanged=false;if(policyChanged)void refreshPolicyAfterSettings(accountId);autosave.refresh();presence.paint();if(room)void presence.publish(room,{force:true});
   void preferenceTask.then(()=>{if(state.user?.id===accountId&&preferences.snapshot().locale!==priorLocale){render();const link=app.querySelector('a[href^="/preferences"]');link?.focus({preventScroll:true});}});
  },
  onNavigateOut:href=>{void (async()=>{if(!await confirmReplace())return;autosave.stop();state.dirty=false;bodySaveBlocked='';location.assign(href);})();}
 });
 autosave.refresh();presence.paint();if(room)void presence.publish(room,{force:true});
}
signal.addEventListener('abort',()=>{for(const controller of layoutControllers)controller.destroy();layoutControllers.clear();autosave.stop();state.selection++;pageReads.clear();cancelPagePrefetch();pageController?.abort();searchController?.abort();exportController?.abort();destroyRoom();blockDnd?.destroy();collectionView?.destroy();for(const controller of databasePlacements.values())controller.destroy();for(const controller of syncedPlacements.values())controller.destroy();presence.destroy();stopAppearance();},{once:true});
if(detailMode){
 const timer=setInterval(()=>{if(!state.current||state.busy||state.loading)return;void request(detailTarget.get('synced')==='1'?basePath()+'/'+encodeURIComponent(detailTarget.get('page')):collectionPath(detailTarget.get('collection'))+'/records/'+encodeURIComponent(detailTarget.get('record'))).catch(error=>{if(![401,403,404].includes(error.status))return;window.parent.postMessage({type:'yumunio:detail-access-lost',workspaceId,accountId:state.user?.id,pageId:detailTarget.get('page')},location.origin);destroyRoom();state.current=null;state.draft=null;state.collection=null;state.locked=true;state.error='forbidden';render();});},10000);signal.addEventListener('abort',()=>clearInterval(timer),{once:true});
 listen(window,'message',event=>{const data=event.data;if(event.origin!==location.origin||event.source!==window.parent||data?.type!=='yumunio:detail-prepare'||data.workspaceId!==workspaceId||data.accountId!==state.user?.id||data.pageId!==state.current?.page.id||typeof data.requestId!=='string')return;void(async()=>{let accepted=false,roomReady=true;app.inert=true;try{if(!state.busy&&!modalOpen()&&!roomCompositions.size&&!clipboardUpload&&!clipboardStarting){if(room)roomReady=await settleRoom();await autosave.flush();await settleBodySave();accepted=roomReady&&!draftPending()&&!room?.client?.pending&&!state.conflict&&!bodySaveBlocked;}}finally{if(!accepted)app.inert=false;window.parent.postMessage({type:'yumunio:detail-prepared',workspaceId,accountId:state.user?.id,pageId:state.current?.page.id,requestId:data.requestId,accepted},location.origin);}})();});
 listen(window,'keydown',event=>{if(!event.isComposing&&event.keyCode!==229&&!roomCompositions.size&&event.key==='Escape'&&!modalOpen()&&!event.defaultPrevented){event.preventDefault();window.parent.postMessage({type:'yumunio:detail-close',workspaceId,accountId:state.user?.id,pageId:state.current?.page.id},location.origin);}});
}
listen(modal,'close',()=>{if(room?.phase==='review' && modal.dataset.view==='roomReviewTitle'){destroyRoom();render();}autosave.refresh();if(room?.needsSync)queueRoomSync(room);});
listen(document,'visibilitychange',()=>{if(document.hidden)void autosave.flush();else{if(room?.phase==='ready')queueRoomSync(room,0);scheduleLiveRefresh();}});
listen(window,'yumunio:content-changed',event=>{const change=event.detail;if(change?.remote&&change.workspaceId===workspaceId&&change.accountId===state.user?.id){concurrentReads.clear();initialPlacements.clear();initialSynced.clear();scheduleLiveRefresh();}});
signal.addEventListener('abort',()=>{clearTimeout(liveTimer);contentStream?.destroy();},{once:true});
listen(document,'focusin',()=>{if(room?.needsSync)queueRoomSync(room);});
listen(document,'compositionend',()=>queueMicrotask(()=>{
 if(room?.renderAfterComposition && !roomCompositions.size){room.renderAfterComposition=false;render();}
 autosave.refresh();
 if(room?.needsSync||room?.client?.pending)queueRoomSync(room,0);
}));
listen(modal,'toggle',presence.paint);
listen(modal,'cancel',event=> { if(state.busy || operation?.pending)event.preventDefault(); });
listen(window,'beforeunload', event => { if (state.dirty || state.busy || bodySaveTask || bodySaveBlocked || clipboardUpload || clipboardStarting) { event.preventDefault(); event.returnValue = ''; } });
listen(window,'pagehide',()=>collectionView?.destroy());
for(const kind of ['copy','cut'])listen(app,kind,event=>{
 if(kind==='copy'&&state.current&&state.user&&!roomCompositions.size){try{const selection=captureEditorTextSelection(app,state.draft.blocks);if(selection){writeEditorBlockClipboard(event.clipboardData,serializeEditorTextSelection(state.draft.blocks,selection,clipboardContext()));event.preventDefault();event.stopPropagation();return;}}catch{}}
 if(!blockSelection.mode||!selectedBlockRoots().length||!blockClipboardEnabled()||event.target.closest?.('input:not(.block-select),textarea,.inline-editor'))return;
 event.preventDefault();void copySelectedBlocks({cut:kind==='cut',data:event.clipboardData});
},{capture:true});
listen(app,'paste',event=>{if(!event.target.closest?.('input:not(.block-select),textarea,.inline-editor')&&pasteSelectedBlocks(event.clipboardData))event.preventDefault();},{capture:true});
listen(app,'focusout',()=>queueMicrotask(refreshCollectionAfterEditing));
listen(app,'focusin',event=>{if(blockSelection.mode&&event.target.closest?.('.inline-editor')){clearBlockSelection();refreshBlockSelectionUi();}});
listen(window,'keydown',event=> {
  if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='s'){event.preventDefault();if(!event.isComposing&&!roomCompositions.size)void autosave.flush();return;}
  if(!modalOpen()&&!event.isComposing&&event.keyCode!==229&&state.draft&&!event.altKey){
   const editor=event.target.closest?.('.inline-editor[data-block-id]'),ids=selectedBlockRoots(),key=event.key.toLowerCase(),command=event.ctrlKey||event.metaKey;
   if(event.key==='Escape'&&blockClipboardEnabled()){
    if(blockSelection.mode){clearBlockSelection();refreshBlockSelectionUi();if(ids[0])focusBlock(ids[0]);event.preventDefault();return;}
    if(editor&&canEditNestedBlock(blockLocation(editor.dataset.blockId))){blockSelection.mode=true;blockSelection.ids=new Set([editor.dataset.blockId]);blockSelection.anchor=editor.dataset.blockId;refreshBlockSelectionUi();app.querySelector('[data-block-select-id="'+editor.dataset.blockId+'"]')?.focus();event.preventDefault();return;}
   }
   if(command&&key==='d'&&!event.shiftKey&&blockClipboardEnabled()&&(editor||ids.length)){event.preventDefault();duplicateBlocks(ids.length?ids:[editor.dataset.blockId]);return;}
   if(blockSelection.mode&&blockClipboardEnabled()&&!editor&&!event.target.closest?.('input:not(.block-select),textarea')){
    if(command&&key==='a'){event.preventDefault();blockSelection.ids=new Set([...indexEditorBlocks(state.draft.blocks).values()].filter(canEditNestedBlock).map(row=>row.block.id));refreshBlockSelectionUi();return;}
    if(!command&&['Backspace','Delete'].includes(event.key)&&ids.length){event.preventDefault();deleteSelectedBlocks();return;}
    if(!command&&event.key==='Enter'&&ids.length){event.preventDefault();clearBlockSelection();refreshBlockSelectionUi();focusBlock(ids[0]);return;}
    if(!command&&['ArrowUp','ArrowDown'].includes(event.key)&&ids.length){
     const rows=[...indexEditorBlocks(state.draft.blocks).values()].filter(row=>canEditNestedBlock(row)&&!row.ancestors.some(parent=>collapsedToggles.has(parent.id))),focused=event.target.closest?.('[data-block-select-id]')?.dataset.blockSelectId||ids.at(-1),position=rows.findIndex(row=>row.block.id===focused),target=rows[position+(event.key==='ArrowDown'?1:-1)];
     if(target){event.preventDefault();blockSelection.ids=new Set(event.shiftKey?editorBlockSelectionRange(state.draft.blocks,blockSelection.anchor||focused,target.block.id):[target.block.id]);if(!event.shiftKey)blockSelection.anchor=target.block.id;refreshBlockSelectionUi();app.querySelector('[data-block-select-id="'+target.block.id+'"]')?.focus();}return;
    }
   }
  }
  if(!modalOpen()&&!event.isComposing&&event.keyCode!==229&&(event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='k'){
    event.preventDefault();void openSearch();return;
  }
  if(modalOpen() || event.isComposing || event.keyCode===229 || !(event.ctrlKey || event.metaKey) || event.altKey || !(event.target?.closest('.inline-editor') || event.target?.id==='page-title'))return;
  if(event.key.toLowerCase()==='z' || event.key.toLowerCase()==='y') {if(applyEditorHistory(event.key.toLowerCase()==='y'||event.shiftKey?'redo':'undo'))event.preventDefault();}
});
listen(window,'keydown', event => { if (event.key === 'Escape' && state.navOpen && !modalOpen()) setNavigation(false); });
const mobileMedia = matchMedia('(max-width: 760px)');
listen(mobileMedia,'change', () => { state.navOpen = false; render(); });
listen(document,'click',event=>{
 const link=event.target.closest?.('.inline-editor a[href]');if(!link||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.defaultPrevented)return;
 const target=workspacePageTarget(link.href,{origin:location.origin,workspaceId});if(target&&state.user&&!state.fatal){event.preventDefault();event.stopPropagation();void selectPage(target.pageId,false,false,null,target);}
},{capture:true});
listen(document,'click', event => {
  const link = event.target.closest('a[href]');
  if(link&&!link.download&&(!link.target||link.target==='_self')&&!event.defaultPrevented&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){const target=workspacePageTarget(link.href,{origin:location.origin,workspaceId});if(target&&state.user&&!state.fatal){event.preventDefault();void selectPage(target.pageId,false,false,null,target);return;}}
  if(link&&!event.defaultPrevented&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){const section=settingsHrefSection(link.href,workspaceId);if(section&&state.user&&!state.fatal){event.preventDefault();openSettings(section);return;}}
  if (!link || link.getAttribute('href')?.startsWith('#') || !(state.dirty||bodySaveTask||bodySaveBlocked||clipboardUpload||clipboardStarting) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void confirmReplace().then(confirmed => { if (confirmed) { autosave.stop();state.dirty = false;bodySaveBlocked='';location.assign(link.href); } });
});
listen(window,'popstate',()=>{
 const target=workspacePageTarget(location.href,{origin:location.origin,workspaceId}),before=state.current?.page.id;
 void (async()=>{if(target)await selectPage(target.pageId,false,false,null,{...target,historyMode:'none'});else await openWorkspaceHome({historyMode:'none'});if(state.current?.page.id===before&&state.current?.page.id!==target?.pageId)pageHistory(before,{historyMode:'push'});})();
});
try {
  const initialLocale=preferences.snapshot().locale;
  const requestedPage=new URL(location.href).searchParams.get('page');
  const bootQuery=new URLSearchParams();if(validId(requestedPage)){bootQuery.set('page',requestedPage);if(collectionViewId)bootQuery.set('view',collectionViewId);}
   const [catalogs,fieldCatalogs,bootRead]=await Promise.all([loadCatalogs({namespace:'workspace',locale:initialLocale,manifest:bundledLocaleManifest,initialCatalogs:workspaceCatalogs}),loadCatalogs({namespace:'collections',locale:initialLocale,manifest:bundledLocaleManifest,initialCatalogs:collectionsCatalogs}),request(workspaceApi('/bootstrap')+(bootQuery.size?'?'+bootQuery:'')).then(value=>({value}),error=>({error}))]);
   const [instance,config]=bootRead.value?.instance?[validateInstanceConfig(bootRead.value.instance),{enabled:true}]:await Promise.all([loadInstanceConfig(),request('/api/auth/config')]);
  const sessionRead=bootRead.value?{value:{user:bootRead.value.user}}:bootRead.error?.status===401?await request('/api/auth/get-session').then(value=>({value}),error=>({error})):{error:bootRead.error};
  instanceConfig=instance;workspaceBrand=createInstanceBrand(instance);applyInstanceDefaults(preferences,instance);
  i18n=createI18n(catalogs,initialLocale);fieldI18n=createI18n(fieldCatalogs,initialLocale);applyPreferences();
  if (!validId(workspaceId)) state.fatal = 'invalidWorkspace';
  else {
    if (!config?.enabled) state.fatal = 'disabled';
    else {
      if(sessionRead.error&&sessionRead.error.status!==401)throw sessionRead.error;
      const session=sessionRead.value;
      if (!session?.user?.id) state.fatal = 'unauthorized';
      else {
        state.user = { id: session.user.id, name: session.user.name };
        preferences = new PreferencesStore({ profileId: state.user.id });applyInstanceDefaults(preferences,instanceConfig);
        await Promise.all([i18n.switchLocale(preferences.snapshot().locale),fieldI18n.switchLocale(preferences.snapshot().locale)]);applyPreferences();
        if (session.user.emailVerified !== true) state.fatal = 'unverified';
        else {
          void request('/api/auth/organization/list').then(workspaces=>{if(signal.aborted)return;const selected=Array.isArray(workspaces)?workspaces.find(item=>item.id===workspaceId):null;if(selected){state.name=selected.name;paintChrome();}}).catch(()=>{});
        }
      }
    }
  }
  restoreSidebarDisclosure();
  if(state.fatal||!bootRead.value)render();
  if (!state.fatal) {
    contentStream=connectContentStream({workspaceId,accountId:state.user.id,signal,onChange:detail=>window.dispatchEvent(new CustomEvent('yumunio:content-changed',{detail})),onDenied:()=>{pageReads.clear();destroyRoom();state.current=null;state.draft=null;state.collection=null;state.pages=[];state.locked=true;state.fatal='unauthorized';render();}});
    if(bootRead.value)applyLiveDirectory(bootRead.value.directory);
    await Promise.all([bootRead.value?Promise.resolve():refreshList(),validId(requestedPage)?selectPage(requestedPage,false,false,null,{historyMode:'replace',hash:location.hash,viewId:collectionViewId,initialPage:bootRead.value?.page,initialError:bootRead.value?.pageError}):Promise.resolve()]);
    if(!validId(requestedPage))render();
    requestAnimationFrame(()=>{if(!signal.aborted){app.dataset.workspaceReadyMs=String(Math.round(performance.now()-mountedAt));if(measureDocument)app.dataset.documentReadyMs=String(Math.round(performance.now()-navigation.startTime));}});
  }
} catch {
  if (i18n) { state.fatal = 'unavailable'; render(); }
  else if(!signal.aborted)throw new Error('WORKSPACE_LOAD_FAILED');
}

if(!signal.aborted)stopAppearance=watchSystemAppearance(()=>preferences?.snapshot(),{onAppearance:({kind})=>workspaceBrand?.apply({kind})});
}
