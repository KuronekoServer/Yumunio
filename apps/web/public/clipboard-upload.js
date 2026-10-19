import {PageUploadFlow,PageUploadError} from './page-upload.js';

/** Sequential uploads retain their bytes and reservation on errors; retries first read server state. */
export class ClipboardUploadBatch{
 constructor({files,accountId,workspaceId,pageId,request,onReview=()=>{},onAttachment=()=>{},createId=()=>crypto.randomUUID()}){
  Object.assign(this,{files,accountId,workspaceId,pageId,request,onReview,onAttachment,createId});this.index=0;this.flow=null;this.busy=false;this.state='ready';this.error=null;
 }
 async review(){
  const session=await this.request({path:'/api/auth/get-session',method:'GET',headers:{'X-Yumunio-Expected-Account':this.accountId}});
  if(session?.user?.id!==this.accountId||session.user.emailVerified!==true)throw new PageUploadError('ACCOUNT_CHANGED',401);
  this.flow??=new PageUploadFlow({accountId:this.accountId,workspaceId:this.workspaceId,pageId:this.pageId,request:this.request,createId:this.createId});
  await this.flow.review();
  await this.onReview({revision:this.flow.revision,page:this.flow.page,document:this.flow.document,attachments:this.flow.attachments});
  if(!this.flow.enabled)throw new PageUploadError('ATTACHMENTS_DISABLED',400);
 }
 async accept(result){await this.onAttachment(result.attachment,{revision:result.revision,version:result.version,index:this.index});this.index++;this.flow=null;}
 async run(){
  if(this.busy||this.state==='done')return;this.busy=true;this.state='uploading';this.error=null;
  try{
   while(this.index<this.files.length){
    await this.review();
    if(this.flow.state==='committed'){
     const attachment=this.flow.attachments.find(row=>row.id===this.flow.assetId);
     if(!attachment)throw new PageUploadError('UPLOAD_RESULT_MISSING',409);
     await this.accept({attachment,revision:this.flow.revision,version:this.flow.version});continue;
    }
    if(!this.flow.file){const file=this.files[this.index];const bytes=new Uint8Array(await file.file.arrayBuffer());await this.flow.prepare({name:file.name,mediaType:file.mediaType,bytes});}
    await this.accept(await this.flow.send());
   }
   this.state='done';this.files=[];
  }catch(error){this.state='paused';this.error=error;throw error;}finally{this.busy=false;}
 }
 /** Cancel reads only. An attachment committed before a lost response is still inserted once. */
 async cancel(){
  if(this.busy)return;this.busy=true;
  try{
   if(this.flow){await this.review();if(this.flow.state==='committed'){const attachment=this.flow.attachments.find(row=>row.id===this.flow.assetId);if(!attachment)throw new PageUploadError('UPLOAD_RESULT_MISSING',409);await this.accept({attachment,revision:this.flow.revision,version:this.flow.version});}}
   this.files=[];this.flow=null;this.state='done';
  }finally{this.busy=false;}
 }
}
