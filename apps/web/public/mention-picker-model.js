import {validateMentions} from './mentions.js';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fold=value=>value.normalize('NFKC').toLocaleLowerCase();
/** An email address and a selection inside an existing reference never trigger suggestions. */
export function mentionQuery(text,selection,mentions=[]){
 if(typeof text!=='string'||!selection||selection.start!==selection.end||!Number.isSafeInteger(selection.start)||selection.start<0||selection.start>text.length)return null;
 if(mentions.some(item=>selection.start>item.start&&selection.start<=item.end))return null;
 const prefix=text.slice(Math.max(0,selection.start-66),selection.start),match=/(?:^|[\s([{「『])@([^\s@]{0,64})$/u.exec(prefix);
 if(!match)return null;
 const start=selection.start-match[1].length-1;
 if(start>0&&/[^\s([{「『]/u.test(text[start-1]))return null;
 return{start,end:selection.end,query:match[1],expectedText:text};
}
export function validMentionDate(value){
 try{validateMentions('date',[{kind:'date',start:0,end:4,date:value}]);return true;}catch{return false;}
}
export function localMentionDate(now=new Date(),offset=0){
 const day=new Date(now);day.setDate(day.getDate()+offset);
 return String(day.getFullYear()).padStart(4,'0')+'-'+String(day.getMonth()+1).padStart(2,'0')+'-'+String(day.getDate()).padStart(2,'0');
}
export function mentionCandidates(candidates,query,{today,tomorrow,now=new Date(),limit=25}={}){
 if(!Array.isArray(candidates)||candidates.length>2000||typeof query!=='string'||query.length>64||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError('INVALID_MENTION_CANDIDATES');
 const seen=new Set(),result=[];
 for(const candidate of candidates){
  if(!candidate||!['person','page'].includes(candidate.kind)||typeof candidate.label!=='string'||!candidate.label.trim()||candidate.label.length>240||/[\u0000-\u001f\u007f]/.test(candidate.label))throw new TypeError('INVALID_MENTION_CANDIDATES');
  const field=candidate.kind==='person'?'accountId':'pageId',id=candidate[field];if(!validId(id))throw new TypeError('INVALID_MENTION_CANDIDATES');
  const key=candidate.kind+':'+id;if(seen.has(key))throw new TypeError('INVALID_MENTION_CANDIDATES');seen.add(key);
  if(!fold(candidate.label).includes(fold(query)))continue;
  result.push({label:candidate.label,text:'@'+candidate.label,target:{kind:candidate.kind,[field]:id}});
 }
 const dates=[{date:localMentionDate(now),label:today||'Today'},{date:localMentionDate(now,1),label:tomorrow||'Tomorrow'}];
 if(validMentionDate(query))dates.unshift({date:query,label:query});
 const used=new Set();
 for(const item of dates){if(used.has(item.date))continue;used.add(item.date);if(query&&!fold(item.label).includes(fold(query))&&!item.date.includes(query))continue;result.push({label:item.label,text:'@'+item.date,target:{kind:'date',date:item.date}});}
 return result.slice(0,limit);
}
