import {renderCollectionProjection,boardProjectionError} from './collection-projection.js';
import {prepareBoardOrderMove,prepareBoardMove} from './board-move-model.js';
import {createBoardDnd} from './board-dnd.js';
import {CollectionEdits} from './workspace-data.js';
import {pageBlocksEqual} from './page-save-result.js';

export function validateWorkspaceCollectionRead(value,page,{workspaceId,collectionId,pageId,baseline,inRoom=false,expectedViewId}){
 const model=new CollectionEdits(value,{workspaceId,collectionId});
 if(expectedViewId!==undefined&&(model.envelope.view?.id??null)!==expectedViewId)throw Object.assign(new Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE',status:0});
 if(model.envelope.pageId!==pageId||page?.page?.id!==pageId||page.page.workspaceId!==workspaceId||model.revision!==page.revision||!inRoom&&(page.document.version!==baseline.document.version||page.page.title!==baseline.page.title||!pageBlocksEqual(page.document.blocks,baseline.document.blocks)))throw Object.assign(new Error('COLLECTION_READ_CHANGED'),{code:'COLLECTION_READ_CHANGED',status:409});
 return model;
}

/** Section-local view lifecycle: it never replaces the workspace body or owns authentication. */
export function mountWorkspaceCollectionView({root,getModel,isCurrent,canRead,canWrite,readView,writeBoard,prepare,onModel,onAccepted,onSelected,onError,onBusyChange,confirmDiscard,projectionOptions,labels,selectedViewId=null,boardFactory=createBoardDnd}={}){
 const document=root.ownerDocument,lifecycle=new AbortController();let active=true,busy=false,writing=false,locked=false,generation=0,board=null,error='',notice='',month=new Date().toISOString().slice(0,7),viewId=getModel()?.envelope.view?.id??null;
 const current=()=>active&&root.isConnected&&isCurrent();
 const text=(key,values)=>labels(key,values);
 const node=(tag,attrs={},children=[])=>{const result=document.createElement(tag);for(const[key,value]of Object.entries(attrs)){if(value===undefined||value===null||value===false)continue;if(key==='disabled')result.disabled=value;else result.setAttribute(key,String(value));}for(const child of Array.isArray(children)?children:[children])if(child!==null&&child!==undefined)result.append(child?.nodeType?child:document.createTextNode(String(child)));return result;};
 const button=(label,action,{disabled=false,selected=false}={})=>{const result=node('button',{type:'button',class:'button collection-view-tab'+(selected?' active':''),disabled,'aria-current':selected?'true':null},label);result.addEventListener('click',()=>{if(current()&&!result.disabled)action();});return result;};
 function restoreFocus(recordId=null){queueMicrotask(()=>{if(!current()||document.hasFocus?.()===false||document.querySelector('dialog[open]')||document.activeElement&&document.activeElement!==document.body&&document.activeElement.isConnected)return;const card=recordId?[...root.querySelectorAll('[data-board-dnd-card]')].find(element=>element.dataset.boardDndCard===recordId):null;const target=card?.querySelector('[data-board-dnd-handle]')??root.querySelector('[aria-current="true"]');if(target&&!target.disabled)target.focus({preventScroll:true});});}
 function busyState(value,kind){busy=value;onBusyChange?.(value,kind);}
 function report(failure,{mutation=false,acknowledged=false}={}){
  const lost=failure?.code==='ACCOUNT_CHANGED'||[401,403,404].includes(failure?.status);
  error=lost?'accessChanged':acknowledged?'savedRefreshFailed':mutation&&(!failure?.status||failure.status>=500)?'uncertain':failure?.code==='PROPERTY_DRAFT_CHANGED'?'embeddedPropertiesChanged':failure?.code==='NOTIFICATIONS_TOO_LARGE'?'assigneeNotificationLimit':failure?.status===409?'conflict':failure?.status===413?'tooLarge':String(failure?.code??'').startsWith('BOARD_')?boardProjectionError(failure.code):'unavailable';
  if(lost||mutation&&(acknowledged||!failure?.status||failure.status>=500||failure.status===409))locked=true;
  onError?.(failure,{mutation,acknowledged,lost});if(lost){board?.destroy();board=null;root.replaceChildren(node('p',{class:'message',role:'alert'},text('accessChanged')));}return lost;
 }
 function paint(){
  if(!current())return;board?.destroy();board=null;const model=getModel();
  const positions=[...root.querySelectorAll('.collection-scroll,.collection-board')].map(element=>[element.scrollLeft,element.scrollTop]),selected=root.querySelector('.record-selected')?.dataset.recordId;
  root.replaceChildren();
  if(error)root.append(node('p',{class:'message',role:'alert'},text(error)));if(notice)root.append(node('p',{class:'hint',role:'status'},text(notice)));
  if(!model)return;
  const tabs=node('nav',{class:'workspace-collection-tabs','aria-label':text('embeddedViews')});
  tabs.append(button(text('allRecords'),()=>void switchView(null),{disabled:busy||!canRead(),selected:viewId===null}));
  for(const view of model.collection.views)tabs.append(button(view.name,()=>void switchView(view.id),{disabled:busy||!canRead(),selected:viewId===view.id}));
  tabs.append(button(text('refresh'),()=>void switchView(viewId,{force:true}),{disabled:busy||!canRead()}));root.append(tabs);
  if(busy)root.append(node('p',{class:'hint',role:'status'},text('loading')));
  const options=projectionOptions(),envelope=model.envelope;
  const available=()=>current()&&getModel()===model&&!busy&&!locked&&canWrite()&&!getModel().dirty;
  const rendered=renderCollectionProjection({...options,document,envelope,t:labels,month,
   blocked:()=>busy||locked,mutationBlocked:()=>busy||locked||!canWrite(),available:()=>current()&&getModel()===model&&!busy&&!locked,
   getScope:()=>available()?JSON.stringify([envelope.collection.workspaceId,envelope.collection.id,viewId,model.revision]):null,
   onMonth:offset=>{if(!current()||busy)return;const next=new Date(month+'-01T00:00:00Z');next.setUTCMonth(next.getUTCMonth()+offset);month=next.toISOString().slice(0,7);paint();},
   onBoardDrop:move=>moveBoard(move),
  });
  root.append(rendered.element);
  [...root.querySelectorAll('.collection-scroll,.collection-board')].forEach((element,index)=>{element.scrollLeft=positions[index]?.[0]??0;element.scrollTop=positions[index]?.[1]??0;});
  if(selected)for(const element of root.querySelectorAll('[data-record-id]'))element.classList.toggle('record-selected',element.dataset.recordId===selected);
  // Read-only views remain navigable; row mutation controls have their own current ACL guards.
  if(rendered.board){const config=rendered.board,move=config.canMove,drop=config.canDrop;config.canMove=id=>available()&&move(id);config.canDrop=(id,key)=>available()&&drop(id,key);board=boardFactory(config);}
 }
 async function load(id,marker){
  const previous=getModel(),drafts=new Map(previous.drafts);
  const model=await readView(id,{signal:lifecycle.signal});if(!current()||marker!==generation)return false;
  if(getModel()!==previous||drafts.size!==previous.drafts.size||[...drafts].some(([key,value])=>previous.drafts.get(key)!==value))throw Object.assign(new Error('PROPERTY_DRAFT_CHANGED'),{code:'PROPERTY_DRAFT_CHANGED',status:400});
  if(!model||model.envelope.view?.id!==(id??undefined)&&!(id===null&&model.envelope.view===null))throw Object.assign(new Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE',status:0});
  await onModel(model);if(!current()||marker!==generation)return false;viewId=id;onSelected?.(id);locked=false;return true;
 }
 async function switchView(id,{force=false}={}){
  if(!current()||busy||!canRead()||!force&&id===viewId||id!==null&&!getModel()?.collection.views.some(view=>view.id===id))return false;
  const model=getModel();if(model?.dirty&&(!confirmDiscard||!await confirmDiscard()))return false;if(!current()||getModel()!==model||busy)return false;
  const marker=++generation;error=notice='';busyState(true,'read');paint();
  try{if(prepare&&await prepare('read')===false)return false;if(!current()||marker!==generation)return false;return await load(id,marker);}
  catch(failure){if(current()&&marker===generation)report(failure);return false;}
  finally{if(active&&marker===generation){busyState(false,'read');paint();}}
 }
 async function moveBoard(move){
  if(!current()||busy||locked||!canWrite()||getModel()?.dirty)return false;
  const model=getModel(),marker=++generation,focusRecord=document.activeElement?.closest?.('[data-board-dnd-card]')?.dataset.boardDndCard;let acknowledged=false;error=notice='';busyState(true,'write');paint();
  try{
   if(prepare&&await prepare('write')===false)return false;if(!current()||marker!==generation||getModel()!==model||!canWrite())return false;
   const intent=Object.hasOwn(move,'beforeRecordId')?prepareBoardOrderMove(model.envelope,move):prepareBoardMove(model.envelope,move);if(!intent)return false;writing=true;
   const result=await writeBoard(intent,{signal:lifecycle.signal});if(!current()||marker!==generation)return false;
   intent.validateResponse(result);acknowledged=true;writing=false;await onAccepted?.(result,intent);if(!current()||marker!==generation)return false;
   if(!await load(viewId,marker))return false;notice='boardMoved';return true;
  }catch(failure){if(current()&&marker===generation)report(failure,{mutation:true,acknowledged});return false;}
  finally{writing=false;if(active&&marker===generation){busyState(false,'write');paint();if(focusRecord)restoreFocus(focusRecord);}}
 }
 paint();
 const ready=selectedViewId!==viewId?switchView(selectedViewId):Promise.resolve(true);
 return{ready,switchView,moveBoard,refresh:()=>switchView(viewId,{force:true}),render:paint,get busy(){return busy;},get active(){return board?.active===true;},cancel(){board?.cancel();},destroy(){if(!active)return;if(writing)onError?.(Object.assign(new Error('REQUEST_UNCONFIRMED'),{code:'REQUEST_UNCONFIRMED',status:0}),{mutation:true,acknowledged:false,lost:false});active=false;generation++;lifecycle.abort();board?.destroy();board=null;if(busy)busyState(false,writing?'write':'read');root.replaceChildren();}};
}
