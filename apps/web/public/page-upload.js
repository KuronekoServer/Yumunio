const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const clone=value=>structuredClone(value);
export class PageUploadError extends Error{constructor(code='UPLOAD_UNCERTAIN',status=0){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new PageUploadError(code,status);};
function asset(value){if(!value||!validId(value.id)||typeof value.name!=='string'||!Number.isSafeInteger(value.size)||value.size<0||value.size>16777216||typeof value.mediaType!=='string')fail('INVALID_UPLOAD_RESPONSE');return value;}
/** Files remain in memory. Only an explicit review reconciles an uncertain mutation. */
export class PageUploadFlow{
  constructor({accountId,workspaceId,pageId,request,createId=()=>crypto.randomUUID()}){
    if(![accountId,workspaceId,pageId].every(validId)||typeof request!=='function'||typeof createId!=='function')throw new TypeError('INVALID_UPLOAD_CLIENT');
    Object.assign(this,{accountId,workspaceId,pageId,request,createId});this.path='/api/content/workspaces/'+encodeURIComponent(workspaceId)+'/pages/'+encodeURIComponent(pageId);this.state='idle';this.busy=false;this.file=null;this.uploadId=null;this.assetId=null;this.page=null;this.uploads=[];this.attachments=[];this.revision=null;this.version=null;this.editable=false;this.enabled=false;
  }
  async call(path,method='GET',body,extra={}){return this.request({path,method,headers:{'X-Yumunio-Expected-Account':this.accountId,...extra},...(body===undefined?{}:{body})});}
  async review(initial=null){
    if(this.busy)fail('UPLOAD_BUSY');this.busy=true;
    try{
      const context=initial??await this.call('/api/content/workspaces/'+encodeURIComponent(this.workspaceId)+'/bootstrap?section=attachments&page='+encodeURIComponent(this.pageId));
      if(context?.user?.id!==this.accountId||context.workspace?.workspaceId!==this.workspaceId)fail('UPLOAD_ACCESS_CHANGED',404);
      const{page,uploads:pending,workspace}=context;
      if(page?.page?.id!==this.pageId||!Array.isArray(page.page.capabilities)||!Number.isSafeInteger(page.document?.version)||page.document.version<1||!Number.isSafeInteger(page.revision)||page.revision<0||pending?.pageId!==this.pageId||!Array.isArray(pending.uploads)||pending.uploads.length>1000||pending.revision!==page.revision||workspace?.revision!==page.revision||typeof workspace.attachmentsEnabled!=='boolean')fail('UPLOAD_REVIEW_CONFLICT',409);
      const attachments=page.attachments??[];if(!Array.isArray(attachments)||attachments.length>1000)fail('INVALID_UPLOAD_RESPONSE');attachments.forEach(asset);
      pending.uploads.forEach(item=>{asset(item);if(!validId(item.uploadId)||!validId(item.sourceId)||typeof item.checksum!=='string'||!/^[a-f0-9]{64}$/.test(item.checksum)||!['reserved','ready','deleting'].includes(item.status))fail('INVALID_UPLOAD_RESPONSE');});
      this.page=clone(page.page);this.document=clone(page.document);this.attachments=clone(attachments);this.uploads=clone(pending.uploads);this.revision=page.revision;this.version=page.document.version;this.editable=page.page.capabilities.includes('editBody');this.enabled=workspace.attachmentsEnabled;
      if(!this.editable)fail('UPLOAD_ACCESS_CHANGED',404);
      if(this.file&&this.uploadId){
        const committed=this.assetId&&attachments.find(item=>item.id===this.assetId);
        if(committed){if(committed.name!==this.file.name||committed.size!==this.file.bytes.length)fail('INVALID_UPLOAD_RESPONSE');this.state='committed';this.file=null;}
        else{
          const row=pending.uploads.find(item=>item.uploadId===this.uploadId&&item.sourceId==='file');
          if(row){if(row.name!==this.file.name||row.size!==this.file.bytes.length||row.checksum!==this.file.checksum||row.mediaType!==this.file.mediaType)fail('INVALID_UPLOAD_RESPONSE');this.assetId=row.id;this.state=row.status==='deleting'?'cancelled':row.status;}
          else if(this.assetId)fail('UPLOAD_RESULT_MISSING',409);
          else this.state='prepared';
        }
      }else if(['uncertain','blocked'].includes(this.state))this.state='idle';
      return this.snapshot();
    }catch(error){this.state='blocked';throw error;}finally{this.busy=false;}
  }
  async prepare({name,mediaType='application/octet-stream',bytes}){
    if(this.busy||this.file||this.state==='blocked'||this.state==='uncertain'||!this.editable||!this.enabled)fail('UPLOAD_NOT_READY');
    if(!(bytes instanceof Uint8Array)||bytes.length>16777216||typeof name!=='string'||!name.trim()||['.','..'].includes(name)||name.length>255||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\]/.test(name))fail('INVALID_UPLOAD_FILE',400);
    try{encodeURIComponent(name);}catch{fail('INVALID_UPLOAD_FILE',400);}
    const captured=bytes.slice();this.busy=true;
    try{const checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',captured)),byte=>byte.toString(16).padStart(2,'0')).join('');const id='upload-'+this.createId();if(!validId(id))fail('INVALID_UPLOAD_FILE');this.file={name,mediaType:mediaType.length<=128&&/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)?mediaType:'application/octet-stream',bytes:captured,checksum};this.uploadId=id;this.assetId=null;this.state='prepared';return this.snapshot();}finally{this.busy=false;}
  }
  snapshot(){return{state:this.state,revision:this.revision,version:this.version,page:clone(this.page),editable:this.editable,enabled:this.enabled,attachments:clone(this.attachments),uploads:clone(this.uploads),file:this.file?{name:this.file.name,mediaType:this.file.mediaType,size:this.file.bytes.length,checksum:this.file.checksum}:null};}
  async send(){
    if(this.busy||!this.file||!['prepared','reserved','ready'].includes(this.state)||!this.editable||!this.enabled)fail('UPLOAD_NOT_READY');this.busy=true;
    const group=this.path+'/uploads/'+encodeURIComponent(this.uploadId)+'/assets';
    try{
      if(this.state==='prepared'){
        const result=await this.call(group,'POST',{expectedRevision:this.revision,sourceId:'file',name:this.file.name,mediaType:this.file.mediaType,size:this.file.bytes.length,checksum:this.file.checksum});
        if(!validId(result?.assetId)||!Number.isSafeInteger(result.revision)||!['reserved','ready'].includes(result.status))fail('INVALID_UPLOAD_RESPONSE');this.assetId=result.assetId;this.revision=result.revision;this.state=result.status;
      }
      const path=group+'/'+encodeURIComponent(this.assetId);
      if(this.state==='reserved'){
        const result=await this.call(path,'PUT',this.file.bytes.slice(),{'Content-Type':'application/octet-stream','X-Yumunio-Expected-Revision':String(this.revision)});
        if(result?.assetId!==this.assetId||result.status!=='ready'||!Number.isSafeInteger(result.revision))fail('INVALID_UPLOAD_RESPONSE');this.revision=result.revision;this.state='ready';
      }
      const result=await this.call(path+'/commit','POST',{expectedRevision:this.revision,expectedVersion:this.version});
      if(!Number.isSafeInteger(result?.revision)||!Number.isSafeInteger(result.version)||typeof result.replayed!=='boolean'||asset(result.attachment).id!==this.assetId||result.attachment.name!==this.file.name||result.attachment.size!==this.file.bytes.length)fail('INVALID_UPLOAD_RESPONSE');
      this.state='committed';this.file=null;return clone(result);
    }catch(error){this.state=error?.status===409?'blocked':'uncertain';throw error;}finally{this.busy=false;}
  }
  discardPrepared(){if(this.busy||this.state!=='prepared')fail('UPLOAD_NOT_READY');this.file=null;this.uploadId=null;this.assetId=null;this.state='idle';}
  /** Discard local bytes only after explicit user consent; server staging is listed separately. */
  discardRetained(){if(this.busy)fail('UPLOAD_BUSY');this.file=null;this.uploadId=null;this.assetId=null;this.state='idle';}
  async removePending(row){
    if(this.busy||['uncertain','blocked'].includes(this.state)||!this.editable||!this.enabled||!this.uploads.some(item=>item.id===row.id&&item.uploadId===row.uploadId))fail('UPLOAD_NOT_READY');this.busy=true;
    try{const result=await this.call(this.path+'/uploads/'+encodeURIComponent(row.uploadId)+'/assets/'+encodeURIComponent(row.id),'DELETE',{expectedRevision:this.revision});if(result?.removed!==true||!Number.isSafeInteger(result.revision))fail('INVALID_UPLOAD_RESPONSE');if(this.assetId===row.id){this.file=null;this.uploadId=null;this.assetId=null;this.state='idle';}return result;}catch(error){this.state=error?.status===409?'blocked':'uncertain';throw error;}finally{this.busy=false;}
  }
  async bindReady(row){
    if(this.busy||this.file||['uncertain','blocked'].includes(this.state)||!this.editable||!this.enabled||row.status!=='ready'||!this.uploads.some(item=>item.id===row.id&&item.uploadId===row.uploadId))fail('UPLOAD_NOT_READY');this.busy=true;
    try{const result=await this.call(this.path+'/uploads/'+encodeURIComponent(row.uploadId)+'/assets/'+encodeURIComponent(row.id)+'/commit','POST',{expectedRevision:this.revision,expectedVersion:this.version});if(!Number.isSafeInteger(result?.revision)||asset(result.attachment).id!==row.id)fail('INVALID_UPLOAD_RESPONSE');return result;}catch(error){this.state=error?.status===409?'blocked':'uncertain';throw error;}finally{this.busy=false;}
  }
  async remove(attachment){
    if(this.busy||this.file||['uncertain','blocked'].includes(this.state)||!this.editable||!this.enabled||!this.attachments.some(item=>item.id===attachment.id))fail('UPLOAD_NOT_READY');this.busy=true;
    try{const result=await this.call(this.path+'/attachments/'+encodeURIComponent(attachment.id),'DELETE',{expectedRevision:this.revision,expectedVersion:this.version});if(result?.removed!==true||!Number.isSafeInteger(result.revision))fail('INVALID_UPLOAD_RESPONSE');return result;}catch(error){this.state=error?.status===409?'blocked':'uncertain';throw error;}finally{this.busy=false;}
  }
}
