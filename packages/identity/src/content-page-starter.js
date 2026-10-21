import {instantiateStructuredPageStarter} from '../../domain/src/page-starter.js';

/** Attach the whole recipe to the same CAS payload as its parent page; never make partial writes. */
export function applyPageStarter({payload,workspaceId,pageId,recipe,createId,stamp,accountId,membershipId}){
 const used=new Set();
 const collect=value=>{if(!value||typeof value!=='object')return;if(typeof value.id==='string')used.add(value.id);for(const child of Object.values(value))if(child&&typeof child==='object')collect(child);};collect(payload);
 const mint=()=>{const id=createId();if(used.has(id)){const error=new Error('CONTENT_UNAVAILABLE');error.code='CONTENT_UNAVAILABLE';throw error;}used.add(id);return id;};
 const plan=instantiateStructuredPageStarter(recipe,mint),db=plan.database;
 if(db){
  const addPage=(id,title,parentId,blocks)=>{
   payload.pages.push({page:{id,workspaceId,title,parentId,createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:id,workspaceId,version:1,blocks,updatedAt:stamp},inheritPermissions:true});
   const grantId=mint();payload.grants.push({id:grantId,workspaceId,pageId:id,accountId,permission:'full',includeDescendants:true,status:'active'});payload.grantBindings.push({grantId,membershipId});
  };
  addPage(db.pageId,db.title,pageId,[]);
  for(const row of db.records)addPage(row.pageId,row.title,db.pageId,row.blocks);
  payload.collections??=[];payload.collections.push({collection:{id:db.id,workspaceId,title:db.title,properties:db.properties,records:db.records.map(({id,values})=>({id,values})),createdAt:stamp,updatedAt:stamp},pageId:db.pageId,recordPages:db.records.map(row=>({recordId:row.id,pageId:row.pageId,sourceValues:{},sourceKind:'manual'})),sourceHeaders:[],sourceProperties:[],views:db.views});
 }
 return{blocks:plan.blocks,receipt:{type:recipe.type,ids:plan.ids}};
}
