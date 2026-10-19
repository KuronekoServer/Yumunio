/** Keep only exact, untouched mention ranges when the surrounding plain text changes. */
export function updateMentionRanges(previous, next, mentions) {
  let start = 0, end = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  while (end < previous.length - start && end < next.length - start && previous[previous.length - 1 - end] === next[next.length - 1 - end]) end++;
  const beforeEnd = previous.length - end, shift = next.length - previous.length;
  return mentions.flatMap(item => {
    if (item.end <= start) return [{ ...item }];
    if (item.start >= beforeEnd) return [{ ...item, start: item.start + shift, end: item.end + shift }];
    return [];
  }).filter(item => next.slice(item.start, item.end) === previous.slice(mentions.find(old => old.accountId === item.accountId).start, mentions.find(old => old.accountId === item.accountId).end));
}
export function appendMention(draft, person) {
  if (draft.mentions.length >= 8 || draft.mentions.some(item => item.accountId === person.accountId)) return structuredClone(draft);
  const separator = draft.text && !/\s$/.test(draft.text) ? ' ' : '', label = '@' + person.name;
  const start = draft.text.length + separator.length;
  return { ...structuredClone(draft), text: draft.text + separator + label + ' ', mentions: [...draft.mentions.map(item => ({ ...item })), { accountId: person.accountId, start, end: start + label.length }] };
}

const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function invalidInbox(){throw Object.assign(new TypeError('INVALID_NOTIFICATIONS'),{code:'INVALID_NOTIFICATIONS'});}
function exactInbox(value,keys,optional=[]){if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)invalidInbox();const properties=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(properties).some(key=>typeof key!=='string'||!keys.includes(key)&&!optional.includes(key))||keys.some(key=>!Object.hasOwn(properties,key))||Object.values(properties).some(item=>!item.enumerable||!Object.hasOwn(item,'value')))invalidInbox();}
/** Page notifications contain no comment, snippet, recipient or container fields. */
export function validateInbox(value){
 exactInbox(value,['revision','notifications']);if(!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.notifications)||value.notifications.length>1000)invalidInbox();const ids=new Set();
 const notifications=value.notifications.map(item=>{const common=['id','pageId','pageTitle','authorId','createdAt','readAt'];exactInbox(item,common,['reason','threadId','messageId','text']);const pageReference=['assignment','inline-mention'].includes(item.reason);exactInbox(item,pageReference?[...common,'reason']:[...common,'threadId','messageId','text'],pageReference?[]:['reason']);
  if(!safeId(item.id)||ids.has(item.id)||!safeId(item.pageId)||!safeId(item.authorId)||typeof item.pageTitle!=='string'||item.pageTitle.length>240||!stamp(item.createdAt)||item.readAt!==null&&!stamp(item.readAt))invalidInbox();ids.add(item.id);
  if(!pageReference&&(!safeId(item.threadId)||!safeId(item.messageId)||typeof item.text!=='string'||item.text.length>500||item.reason!==undefined&&!['mention','reply'].includes(item.reason)))invalidInbox();return{...item,reason:item.reason??'mention'};
 });return{revision:value.revision,notifications};
}
export function notificationHref(workspaceId,notification){
 if(!safeId(workspaceId))invalidInbox();const item=validateInbox({revision:0,notifications:[notification]}).notifications[0];
 return ['assignment','inline-mention'].includes(item.reason)?'/workspace?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(item.pageId):'/comments?workspace='+encodeURIComponent(workspaceId)+'&page='+encodeURIComponent(item.pageId)+'#thread-'+encodeURIComponent(item.threadId);
}
