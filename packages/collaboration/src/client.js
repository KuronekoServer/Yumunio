import { Y, CollaborationError, ROOM_LIMITS, editableRoomKeys, loadRoomDocument, validateRoomDocument, inspectUpdate, inspectStateVector, toBase64, fromBase64,
 loadStructuredRoom,validateStructuredRoom,structuredRoomKeys,structuredRoomOperation,structuredRoomFormat,structuredRoomText,structuredRoomConflicts,structuredRoomFeatures,structuredRoomSelection,resolveStructuredRoomSelection,STRUCTURED_ROOM_FEATURES } from './index.js';
import {PRESENCE_LIMITS,validPresenceClientId,validatePresenceCursor,validatePresenceSnapshot} from './presence.js';

function readonlyCopy(value) {
  const copy=structuredClone(value),pending=[copy];
  for(let index=0;index<pending.length;index++){const item=pending[index];if(item&&typeof item==='object'&&!Object.isFrozen(item)){pending.push(...Object.values(item).filter(child=>child&&typeof child==='object'));Object.freeze(item);}}
  return copy;
}

/** Transport receives {path,method,headers,body}; it must use same-origin authenticated HTTP. */
export class HttpRoomClient {
  #lifecycle=0;
  #selections=new WeakMap();
  #presence=null;
  #presenceReceivedAt=0;
  #presenceVersion=0;
  #presenceTail=Promise.resolve();
  constructor({accountId,workspaceId,pageId,draft,request,presenceClientId=crypto.randomUUID(),protocol=1,features}) {
    const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    if(![accountId,workspaceId,pageId].every(id)||typeof request!=='function'||!validPresenceClientId(presenceClientId))throw new TypeError('INVALID_ROOM_CLIENT');
    if(![1,2].includes(protocol))throw new TypeError('INVALID_ROOM_CLIENT');this.protocol=protocol;this.seed=null;this.localOrigin=Object.freeze({});this.undoManager=null;
    if(features===undefined)features=protocol===2?[...STRUCTURED_ROOM_FEATURES]:[];
    if(!Array.isArray(features)||new Set(features).size!==features.length||features.some(feature=>!STRUCTURED_ROOM_FEATURES.includes(feature))||protocol!==2&&features.length)throw new TypeError('INVALID_ROOM_CLIENT');
    this.features=Object.freeze([...features]);this.serverFeatures=Object.freeze([]);
    this.presenceClientId=presenceClientId;
    this.accountId=accountId;this.workspaceId=workspaceId;this.pageId=pageId;this.baseline=structuredClone(draft);this.allowed=new Set(editableRoomKeys(draft));
    this.request=request;this.doc=null;this.epoch=null;this.ticket=null;this.status='closed';this.pending=false;this.generation=0;this.busy=false;this.sequence=0;
    this.path='/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/pages/'+encodeURIComponent(pageId)+'/room';
  }
  requestHeaders(extra={}){return{'X-Yumunio-Expected-Account':this.accountId,...(this.protocol===2?{'X-Yumunio-Room-Protocol':'2'}:{}),...(this.features.includes('check-state')?{'X-Yumunio-Room-Features':'check-state'}:{}),...(this.features.includes('block-transforms')?{'X-Yumunio-Room-Extensions':'block-transforms'}:{}),...extra};}
  async #request(suffix,method,body,extra={}) {
    const lifecycle=this.#lifecycle;
    try{return await this.request({path:this.path+suffix,method,headers:this.requestHeaders(extra),...(body===undefined?{}:{body})});}
    catch(error){if(lifecycle===this.#lifecycle&&(error?.status===401||error?.status===403||error?.status===404||['ROOM_EPOCH_CHANGED','ROOM_PROTOCOL_UNSUPPORTED'].includes(error?.code))){this.status='stale';this.#clearPresence();}throw error;}
  }
  #prepare(value,{opening=false}={}) {
    if(this.protocol===2?value?.protocol!==2:value?.protocol===2){this.status='stale';throw new CollaborationError('ROOM_PROTOCOL_UNSUPPORTED',409);}
    const seed=this.protocol===2?(opening?value.seed:this.seed):null;if(this.protocol===2&&(!seed||typeof seed.title!=='string'||!Array.isArray(seed.blocks)))throw new CollaborationError('INVALID_ROOM_RESPONSE');
    const serverFeatures=opening?(Object.hasOwn(value,'supportedFeatures')?value.supportedFeatures:[]):this.serverFeatures;
    if(!Array.isArray(serverFeatures)||new Set(serverFeatures).size!==serverFeatures.length||serverFeatures.some(feature=>!STRUCTURED_ROOM_FEATURES.includes(feature))||this.protocol!==2&&Object.hasOwn(value,'supportedFeatures'))throw new CollaborationError('INVALID_ROOM_RESPONSE');
    if(!value||value.pageId!==this.pageId||typeof value.epoch!=='string'||!Number.isSafeInteger(value.sequence)||value.sequence<1||
      !Number.isSafeInteger(value.revision)||value.revision<0||!Number.isSafeInteger(value.documentVersion)||value.documentVersion<1||typeof value.editable!=='boolean')throw new CollaborationError('INVALID_ROOM_RESPONSE');
    if(this.epoch&&value.epoch!==this.epoch){this.status='stale';throw new CollaborationError('ROOM_EPOCH_CHANGED',409);}
    if(this.doc&&(value.sequence<this.sequence||value.revision<this.revision||value.documentVersion<this.documentVersion))throw new CollaborationError('INVALID_ROOM_RESPONSE');
    const update=fromBase64(value.update),vector=fromBase64(value.stateVector,1024);inspectUpdate(update,{state:true,protocol:this.protocol});inspectStateVector(vector);
    if(opening&&(typeof value.ticket!=='string'||typeof value.expiresAt!=='string'))throw new CollaborationError('INVALID_ROOM_RESPONSE');
    const load=input=>this.protocol===2?loadStructuredRoom(input,seed):loadRoomDocument(input,this.baseline,{requireBaselineMatch:false}),validate=(doc,baseline)=>this.protocol===2?validateStructuredRoom(doc,seed):validateRoomDocument(doc,baseline);
    const server=load(this.serverState??update);
    let serverDraft,serverState;
    try {
      if(this.serverState)Y.applyUpdate(server,update);serverDraft=validate(server,this.baseline);if(this.protocol===2&&structuredRoomFeatures(server).some(feature=>!this.features.includes(feature)||!serverFeatures.includes(feature))){this.status='stale';throw new CollaborationError('ROOM_PROTOCOL_UNSUPPORTED',409);}
      if(toBase64(Y.encodeStateVector(server))!==toBase64(vector))throw new CollaborationError('INVALID_ROOM_RESPONSE');
      serverState=Y.encodeStateAsUpdate(server);
    }finally{server.destroy();}
    const candidate=this.doc?load(Y.encodeStateAsUpdate(this.doc)):load(update);
    try {
      if(this.doc)Y.applyUpdate(candidate,update);const draft=validate(candidate,serverDraft);
      return{value,update,vector,serverDraft,serverState,candidate,draft,seed,serverFeatures};
    }catch(error){candidate.destroy();throw error;}
  }
  #commit(prepared,{opening=false}={}) {
    const{value,update,vector,serverDraft,serverState,candidate,seed,serverFeatures}=prepared,marker=this.#operation();
    try {
      if(this.doc){Y.applyUpdate(this.doc,update,'remote');this.#assertOperation(marker);}else this.doc=candidate;
      this.baseline=serverDraft;this.serverState=serverState;
      this.epoch=value.epoch;this.sequence=value.sequence;this.revision=value.revision;this.documentVersion=value.documentVersion;this.editable=value.editable;this.serverVector=vector;
      if(opening){this.ticket=value.ticket;this.expiresAt=value.expiresAt;this.serverFeatures=Object.freeze([...serverFeatures]);if(this.protocol===2){this.seed=structuredClone(seed);this.undoManager=new Y.UndoManager([this.doc.getArray('operations'),...structuredRoomKeys(this.doc,this.seed).map(key=>this.doc.getText(key))],{trackedOrigins:new Set([this.localOrigin]),captureTimeout:500});}}
      if(this.protocol===2){this.allowed=new Set(structuredRoomKeys(this.doc,this.seed));for(const key of this.allowed)this.undoManager?.addToScope(this.doc.getText(key));}
      this.status='ready';
    }catch(error){
      if(this.status==='ready')this.stop();
      if(error?.code==='ROOM_CLIENT_STOPPED')throw error;
      throw new CollaborationError('ROOM_APPLY_FAILED',409);
    }finally{if(candidate!==this.doc)candidate.destroy();}
  }
  #operation() {return{lifecycle:this.#lifecycle,doc:this.doc,epoch:this.epoch,status:this.status};}
  #assertOperation(marker) {
    if(this.#lifecycle!==marker.lifecycle||this.doc!==marker.doc||this.epoch!==marker.epoch||this.status!==marker.status)throw new CollaborationError('ROOM_CLIENT_STOPPED',409);
  }
  async open({expectedRevision,reset=false}) {
    if(this.busy||this.status==='stale')throw new CollaborationError('ROOM_CLIENT_STOPPED',409);
    const marker=this.#operation();this.busy=true;
    try {
      const value=await this.#request('/open','POST',{expectedRevision,...(this.protocol===2?{protocol:2,...(reset?{reset:true}:{})}:{})});this.#assertOperation(marker);
      const prepared=this.#prepare(value,{opening:true});this.#commit(prepared,{opening:true});return this.snapshot();
    }finally{this.busy=false;}
  }
  /** Scheduling hint only. The server clock exclusively controls ticket validity and grace. */
  ticketRenewalDue({now=Date.now(),withinMs=60000}={}) {
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(withinMs)||withinMs<0||withinMs>15*60*1000)throw new TypeError('INVALID_ROOM_RENEWAL_CLOCK');
    return this.status==='ready'&&!!this.doc&&Number.isFinite(Date.parse(this.expiresAt))&&Date.parse(this.expiresAt)-now<=withinMs;
  }
  /** Refreshes only authorization metadata. It neither acknowledges input nor imports remote content. */
  async renew() {
    if(!this.doc||this.busy||this.status!=='ready'||!this.ticket||!this.epoch)throw new CollaborationError('ROOM_CLIENT_STOPPED',409);
    const captured={...this.#operation(),ticket:this.ticket,editable:this.editable,expiresAt:this.expiresAt};this.busy=true;
    try {
      const value=await this.#request('/renew','POST',{epoch:captured.epoch,ticket:captured.ticket});
      this.#assertOperation(captured);if(this.ticket!==captured.ticket)throw new CollaborationError('ROOM_CLIENT_STOPPED',409);
      const keys=['revision','pageId','epoch','sequence','documentVersion','editable','ticket','expiresAt'];
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||value.pageId!==this.pageId||typeof value.epoch!=='string'||!Number.isSafeInteger(value.sequence)||value.sequence<this.sequence||!Number.isSafeInteger(value.revision)||value.revision<this.revision||!Number.isSafeInteger(value.documentVersion)||value.documentVersion<this.documentVersion||typeof value.editable!=='boolean'||typeof value.ticket!=='string'||!value.ticket.length||value.ticket.length>2500||!/^[A-Za-z0-9_.-]+$/.test(value.ticket)||typeof value.expiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)||!Number.isFinite(Date.parse(value.expiresAt))||new Date(value.expiresAt).toISOString()!==value.expiresAt||Date.parse(value.expiresAt)<Date.parse(captured.expiresAt))throw new CollaborationError('INVALID_ROOM_RESPONSE');
      if(value.epoch!==captured.epoch){this.status='stale';throw new CollaborationError('ROOM_EPOCH_CHANGED',409);}
      if(value.editable!==captured.editable){this.status='stale';throw new CollaborationError('ROOM_NOT_EDITABLE',409);}
      const needsSync=value.sequence!==this.sequence||value.revision!==this.revision||value.documentVersion!==this.documentVersion;
      this.ticket=value.ticket;this.expiresAt=value.expiresAt;
      return{expiresAt:value.expiresAt,editable:value.editable,needsSync,server:{sequence:value.sequence,revision:value.revision,documentVersion:value.documentVersion}};
    }finally{this.busy=false;}
  }
  snapshot(){if(!this.doc)return null;return this.protocol===2?validateStructuredRoom(this.doc,this.seed):validateRoomDocument(this.doc,this.baseline);}
  get canUndo(){return this.protocol===2&&!!this.undoManager?.canUndo();}
  get canRedo(){return this.protocol===2&&!!this.undoManager?.canRedo();}
  get operationConflicts(){return this.protocol===2&&this.doc?structuredRoomConflicts(this.doc,this.seed):[];}
  supportsFeature(feature){return this.protocol===2&&this.features.includes(feature)&&this.serverFeatures.includes(feature);}
  setChecked({blockId,checked}){return this.operation({kind:'check',blockId,checked});}
  operation(operation,{text,marks=[]}={}){if(this.protocol!==2||!this.doc||this.status!=='ready'||!this.editable)throw new CollaborationError('ROOM_NOT_EDITABLE');if((operation?.kind==='check'&&!this.supportsFeature('check-state')||['split','merge','convert'].includes(operation?.kind)&&!this.supportsFeature('block-transforms'))||['check','split','merge','convert'].includes(operation?.kind)&&text!==undefined)throw new CollaborationError('ROOM_FEATURE_UNSUPPORTED',409);const id=crypto.randomUUID(),candidate=loadStructuredRoom(Y.encodeStateAsUpdate(this.doc),this.seed);let noOp=false;try{candidate.clientID=this.doc.clientID;structuredRoomOperation(candidate,this.seed,operation,{createId:()=>id});noOp=operation.kind==='check'&&candidate.getArray('operations').length===this.doc.getArray('operations').length;if(text!==undefined)structuredRoomText(candidate,'block:'+operation.blockId,text,{marks,base:this.seed});validateStructuredRoom(candidate,this.seed);inspectUpdate(Y.encodeStateAsUpdate(candidate,this.serverVector),{protocol:2});}finally{candidate.destroy();}if(noOp)return this.snapshot();this.undoManager.stopCapturing();structuredRoomOperation(this.doc,this.seed,operation,{origin:this.localOrigin,createId:()=>id});this.allowed=new Set(structuredRoomKeys(this.doc,this.seed));for(const key of this.allowed)this.undoManager.addToScope(this.doc.getText(key));if(text!==undefined)this.setText('block:'+operation.blockId,text,{marks});this.undoManager.stopCapturing();this.pending=true;this.generation++;return this.snapshot();}
  setMarks({blockId,start,end,marks}){if(this.protocol!==2||!this.doc||this.status!=='ready'||!this.editable)throw new CollaborationError('ROOM_NOT_EDITABLE');const candidate=loadStructuredRoom(Y.encodeStateAsUpdate(this.doc),this.seed);try{candidate.clientID=this.doc.clientID;structuredRoomFormat(candidate,this.seed,{blockId,start,end,marks});inspectUpdate(Y.encodeStateAsUpdate(candidate,this.serverVector),{protocol:2});}finally{candidate.destroy();}this.undoManager.stopCapturing();structuredRoomFormat(this.doc,this.seed,{blockId,start,end,marks},{origin:this.localOrigin});this.undoManager.stopCapturing();this.pending=true;this.generation++;return this.snapshot();}
  history(direction){if(this.protocol!==2||!this.doc||this.status!=='ready'||!this.editable||!['undo','redo'].includes(direction))throw new CollaborationError('ROOM_NOT_EDITABLE');this.undoManager.stopCapturing();const result=this.undoManager[direction]();if(result){this.pending=true;this.generation++;}return this.snapshot();}
  setText(key,value,{marks=[]}={}) {
    if(!this.doc||this.status!=='ready'||!this.editable||!this.allowed.has(key)||typeof value!=='string'||value.length>(key==='title'?240:100000))throw new CollaborationError('ROOM_NOT_EDITABLE');
    const text=this.doc.getText(key),previous=this.protocol===2?(key==='title'?this.snapshot().title:(()=>{const visit=blocks=>blocks.flatMap(block=>[block,...visit(block.children??[])]);return visit(this.snapshot().blocks).find(block=>'block:'+block.id===key)?.data?.text;})()):text.toString();if(previous===value)return;
    if(this.protocol===2){const candidate=loadStructuredRoom(Y.encodeStateAsUpdate(this.doc),this.seed);try{candidate.clientID=this.doc.clientID;structuredRoomText(candidate,key,value,{marks,base:this.seed});validateStructuredRoom(candidate,this.seed);inspectUpdate(Y.encodeStateAsUpdate(candidate,this.serverVector),{protocol:2});}finally{candidate.destroy();}structuredRoomText(this.doc,key,value,{origin:this.localOrigin,marks,base:this.seed});this.pending=true;this.generation++;return;}
    let start=0;while(start<previous.length&&start<value.length&&previous[start]===value[start])start++;
    let end=0;while(end<previous.length-start&&end<value.length-start&&previous[previous.length-1-end]===value[value.length-1-end])end++;
    this.doc.transact(()=>{text.delete(start,previous.length-start-end);text.insert(start,value.slice(start,value.length-end));},'local');
    this.pending=true;this.generation++;
  }
  /** Opaque, in-memory caret markers never leave this client or its current room epoch. */
  captureRelativeSelection({key,start,end=start,direction='none'}={}) {
    if(!this.doc||this.status!=='ready'||!this.allowed.has(key)||!this.doc.share.has(key)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||!['forward','backward','none'].includes(direction))return null;
    if(this.protocol===2){try{const positions=structuredRoomSelection(this.doc,this.seed,{key,start,end});if(!positions)return null;const marker=Object.freeze({});this.#selections.set(marker,{...this.#operation(),key,direction,...positions});return marker;}catch{return null;}}
    const field=this.doc.share.get(key);if(!(field instanceof Y.Text))return null;
    const text=field.toString(),boundary=index=>index>=0&&index<=text.length&&!(index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index]));
    if(!boundary(start)||!boundary(end))return null;
    const marker=Object.freeze({});this.#selections.set(marker,{...this.#operation(),key,direction,start:Y.createRelativePositionFromTypeIndex(field,start,0),end:Y.createRelativePositionFromTypeIndex(field,end,start===end?0:-1)});return marker;
  }
  resolveRelativeSelection(marker) {
    const saved=marker&&typeof marker==='object'?this.#selections.get(marker):null;
    if(!saved||this.status!=='ready'||this.#lifecycle!==saved.lifecycle||this.doc!==saved.doc||this.epoch!==saved.epoch||!this.allowed.has(saved.key)||!this.doc?.share.has(saved.key))return null;
    if(this.protocol===2){try{const selection=resolveStructuredRoomSelection(this.doc,this.seed,saved);return selection?{...selection,direction:selection.start===selection.end?'none':saved.direction}:null;}catch{return null;}}
    const field=this.doc.share.get(saved.key);if(!(field instanceof Y.Text))return null;
    try {
      const left=Y.createAbsolutePositionFromRelativePosition(saved.start,this.doc),right=Y.createAbsolutePositionFromRelativePosition(saved.end,this.doc);
      if(!left||!right||left.type!==field||right.type!==field)return null;
      const start=Math.min(left.index,right.index),end=Math.max(left.index,right.index),text=field.toString(),boundary=index=>Number.isSafeInteger(index)&&index>=0&&index<=text.length&&!(index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index]));
      if(!boundary(start)||!boundary(end))return null;
      return{key:saved.key,start,end,direction:start===end?'none':saved.direction};
    }catch{return null;}
  }
  #bindingFailure() {
    if(this.status==='ready')this.stop();throw new CollaborationError('ROOM_APPLY_FAILED',409);
  }
  #syncResult(deferred=false) {return{draft:this.snapshot(),pending:this.pending,revision:this.revision,sequence:this.sequence,...(deferred?{deferred:true}:{})};}
  #applySync(value,{phase,canApply,onApply,marker,ackGeneration}) {
    const prepared=this.#prepare(value),generation=this.generation;
    try {
      if(canApply){
        let allowed;try{allowed=canApply(Object.freeze({phase,draft:readonlyCopy(prepared.draft)}));if(allowed&&typeof allowed.then==='function'){Promise.resolve(allowed).catch(()=>{});this.#bindingFailure();}}catch{this.#bindingFailure();}
        this.#assertOperation(marker);
        if(typeof allowed!=='boolean'||this.generation!==generation)this.#bindingFailure();
        if(!allowed)return false;
      }
      this.#assertOperation(marker);this.#commit(prepared);
      if(phase==='ack'&&this.generation===ackGeneration)this.pending=false;
      if(onApply){
        try{const returned=onApply({phase,draft:this.snapshot(),pending:this.pending,revision:this.revision,sequence:this.sequence,documentVersion:this.documentVersion,editable:this.editable});if(returned&&typeof returned.then==='function'){Promise.resolve(returned).catch(()=>{});this.#bindingFailure();}}catch{this.#bindingFailure();}
        this.#assertOperation(marker);
      }
      return true;
    }finally{if(prepared.candidate!==this.doc&&!prepared.candidate.isDestroyed)prepared.candidate.destroy();}
  }
  /** Hooks run synchronously in the same turn as acceptance; returning a Promise is unsupported. */
  async sync({canApply,onApply}={}) {
    if(canApply!==undefined&&typeof canApply!=='function'||onApply!==undefined&&typeof onApply!=='function')throw new TypeError('INVALID_ROOM_SYNC_OPTIONS');
    if(!this.doc||this.busy||this.status!=='ready')throw new CollaborationError('ROOM_CLIENT_STOPPED',409);
    const marker=this.#operation();this.busy=true;
    try {
      const pulled=await this.#request('','GET',undefined,{'X-Yumunio-Room-Ticket':this.ticket,'X-Yumunio-State-Vector':toBase64(this.serverVector)});this.#assertOperation(marker);
      if(!this.#applySync(pulled,{phase:'pull',canApply,onApply,marker}))return this.#syncResult(true);
      if(this.pending) {
        if(!this.editable)throw new CollaborationError('ROOM_NOT_EDITABLE');
        const generation=this.generation,update=Y.encodeStateAsUpdate(this.doc,this.serverVector);inspectUpdate(update,{protocol:this.protocol});
        const result=await this.#request('/updates','POST',{epoch:this.epoch,ticket:this.ticket,update:toBase64(update)});this.#assertOperation(marker);
        if(result?.acknowledged!==true)throw new CollaborationError('INVALID_ROOM_RESPONSE');
        if(!this.#applySync(result,{phase:'ack',canApply,onApply,marker,ackGeneration:generation}))return this.#syncResult(true);
      }
      return this.#syncResult();
    }finally{this.busy=false;}
  }
  #clearPresence(){this.#presenceVersion++;this.#presence=null;this.#presenceReceivedAt=0;}
  #queuePresence(task){const result=this.#presenceTail.catch(()=>{}).then(task);this.#presenceTail=result.catch(()=>{});return result;}
  /** Local expiry is relative to the received server clock, never a guessed account name. */
  presenceSnapshot({now=Date.now()}={}){
    if(!Number.isSafeInteger(now))throw new TypeError('INVALID_ROOM_PRESENCE_CLOCK');
    if(!this.#presence||this.status!=='ready')return null;
    const value=this.#presence,elapsed=Math.max(0,now-this.#presenceReceivedAt),sameBasis=!this.pending&&value.sequence===this.sequence&&value.documentVersion===this.documentVersion;
    return readonlyCopy({...value,participants:value.participants.filter(item=>elapsed<Math.min(PRESENCE_LIMITS.ttlMs,Date.parse(item.expiresAt)-Date.parse(value.serverTime))).map(item=>({...item,cursor:sameBasis?item.cursor:null}))});
  }
  async #presenceRequest({publish=false,cursor=null}={}){
    if(!this.doc||this.status!=='ready'||!this.ticket)throw new CollaborationError('ROOM_CLIENT_STOPPED',409);
    if(this.busy)return{deferred:true};
    const marker=this.#operation(),version=++this.#presenceVersion;
    const input=publish?{epoch:this.epoch,ticket:this.ticket,clientId:this.presenceClientId,sequence:this.sequence,documentVersion:this.documentVersion,cursor:this.pending?null:validatePresenceCursor(cursor,this.snapshot())}:undefined;
    try{
      const ticket=this.ticket,clientId=this.presenceClientId;
      const value=await this.#queuePresence(()=>{this.#assertOperation(marker);return this.#request('/presence',publish?'POST':'GET',input,{'X-Yumunio-Room-Ticket':ticket,'X-Yumunio-Presence-Client':clientId});});this.#assertOperation(marker);
      if(version!==this.#presenceVersion)return this.presenceSnapshot();
      this.#presence=validatePresenceSnapshot(value,{pageId:this.pageId,epoch:this.epoch,sequence:this.sequence,documentVersion:this.documentVersion,draft:this.snapshot()});this.#presenceReceivedAt=Date.now();return this.presenceSnapshot();
    }catch(error){if(version===this.#presenceVersion)this.#clearPresence();throw error;}
  }
  publishPresence({cursor=null}={}){return this.#presenceRequest({publish:true,cursor});}
  readPresence(){return this.#presenceRequest();}
  /** Best effort on navigation; expiry still removes a client when unload cannot send. */
  async leavePresence(){
    const usable=this.doc&&this.status==='ready'&&this.ticket,body={epoch:this.epoch,ticket:this.ticket,clientId:this.presenceClientId};this.#clearPresence();
    if(!usable)return{left:false};
    // Keep DELETE ordered after every earlier publish even when stop/destroy runs during unload.
    // It must not change a closed room's authorization status or accept any presence metadata.
    const call={path:this.path+'/presence',method:'DELETE',headers:{'X-Yumunio-Expected-Account':this.accountId,...(this.protocol===2?{'X-Yumunio-Room-Protocol':'2'}:{}),...(this.features.includes('check-state')?{'X-Yumunio-Room-Features':'check-state'}:{}),...(this.features.includes('block-transforms')?{'X-Yumunio-Room-Extensions':'block-transforms'}:{})},body};
    const result=await this.#queuePresence(()=>this.request(call));
    if(!result||Object.keys(result).length!==1||result.left!==true)throw new CollaborationError('INVALID_ROOM_RESPONSE');return result;
  }
  stop(){this.#lifecycle++;this.#clearPresence();this.status='stale';}
  destroy(){this.#lifecycle++;this.#clearPresence();this.undoManager?.destroy();this.undoManager=null;this.doc?.destroy();this.doc=null;this.status='closed';}
}
export { ROOM_LIMITS, PRESENCE_LIMITS };
export {RoomSocketTransport} from './socket-client.js';
