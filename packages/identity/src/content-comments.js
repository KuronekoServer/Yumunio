import { assertId, assertPlainObject, assertJsonSerializable, createPageAccessEvaluator } from '@yumunio/domain';
import {assignmentNotifications,inlineMentionNotifications} from './content-activity.js';

const limits = Object.freeze({ threads: 100, messages: 500, notifications: 1000, bytes: 240000, text: 10000, mentions: 8 });
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
export class ContentCommentsError extends Error { constructor(code = 'INVALID_CONTENT', status = 400) { super(code); this.code = code; this.status = status; } }
const fail = (code, status) => { throw new ContentCommentsError(code, status); };
const missing = () => fail('CONTENT_NOT_FOUND', 404), conflict = () => fail('CONTENT_CONFLICT', 409);
function exact(value, allowed, required = allowed) {
  assertPlainObject(value); assertJsonSerializable(value);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail();
}
function timestamp(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail('INVALID_REVISION'); }
function text(value) { if (typeof value !== 'string' || !value.trim() || value.length > limits.text) fail(); }
const splitSurrogate = (value, index) => index > 0 && /[\uD800-\uDBFF]/.test(value[index - 1]) && /[\uDC00-\uDFFF]/.test(value[index]);
function mentions(value, body, stored) {
  if (!Array.isArray(value) || value.length > limits.mentions) fail();
  let previous = 0; const recipients = new Set();
  for (const item of value) {
    exact(item, stored ? ['accountId', 'membershipId', 'start', 'end'] : ['accountId', 'start', 'end']); assertId(item.accountId);
    if (stored) assertId(item.membershipId);
    if (recipients.has(item.accountId) || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < previous || item.end <= item.start + 1 || item.end > body.length || body[item.start] !== '@' || splitSurrogate(body, item.start) || splitSurrogate(body, item.end)) fail();
    previous = item.end; recipients.add(item.accountId);
  }
}
export function validateDiscussion(payload, pages) {
  if (!Object.hasOwn(payload, 'discussion')) return;
  const data = payload.discussion; exact(data, ['threads', 'notifications']);
  if (!Array.isArray(data.threads) || data.threads.length > limits.threads || !Array.isArray(data.notifications) || data.notifications.length > limits.notifications || size(data) > limits.bytes) fail();
  const ids = new Set(), messages = new Map(); let count = 0;
  const unique = id => { assertId(id); if (ids.has(id)) fail(); ids.add(id); };
  for (const thread of data.threads) {
    exact(thread, ['id', 'pageId', 'blockId', 'createdAt', 'updatedAt', 'resolvedAt', 'messages']); unique(thread.id); assertId(thread.pageId);
    if (!pages.has(thread.pageId)) fail(); if (thread.blockId !== null) assertId(thread.blockId);
    timestamp(thread.createdAt); timestamp(thread.updatedAt); if (thread.resolvedAt !== null) timestamp(thread.resolvedAt);
    if (!Array.isArray(thread.messages) || !thread.messages.length) fail();
    for (const [messageIndex,message] of thread.messages.entries()) {
      if (++count > limits.messages) fail();
      exact(message, ['id', 'authorId', 'authorMembershipId', 'text', 'mentions', 'createdAt', 'updatedAt', 'deletedAt']);
      unique(message.id); assertId(message.authorId); assertId(message.authorMembershipId); timestamp(message.createdAt); timestamp(message.updatedAt);
      if (message.deletedAt !== null) { timestamp(message.deletedAt); if (message.text !== '' || message.mentions.length) fail(); }
      else text(message.text);
      mentions(message.mentions, message.text, true); messages.set(message.id, { thread, message, messageIndex });
    }
  }
  const recipients = new Set();
  for (const notification of data.notifications) {
    const fields=['id','pageId','threadId','messageId','recipientId','recipientMembershipId','createdAt','readAt'];exact(notification,[...fields,'reason'],fields);if(Object.hasOwn(notification,'reason')&&!['mention','reply'].includes(notification.reason))fail();unique(notification.id);
    for (const key of ['pageId', 'threadId', 'messageId', 'recipientId', 'recipientMembershipId']) assertId(notification[key]);
    timestamp(notification.createdAt); if (notification.readAt !== null) timestamp(notification.readAt);
    const entry = messages.get(notification.messageId), key = notification.messageId + '/' + notification.recipientId;
    if (!entry || entry.thread.id !== notification.threadId || entry.thread.pageId !== notification.pageId || entry.message.deletedAt!==null || entry.message.authorId===notification.recipientId || recipients.has(key)) fail();
    const bound=notification.reason==='reply'?entry.thread.messages.slice(0,entry.messageIndex).some(item=>item.authorId===notification.recipientId&&item.authorMembershipId===notification.recipientMembershipId):entry.message.mentions.some(item=>item.accountId===notification.recipientId&&item.membershipId===notification.recipientMembershipId);if(!bound)fail();
    recipients.add(key);
  }
}
function blockExists(blocks, id) { return blocks.some(block => block.data?.purpose !== 'import-source' && (block.id === id || block.children && blockExists(block.children, id))); }
const requestAccessCaches = new WeakMap();
function accessFor(context, accountId, pageId) {
  let cache = requestAccessCaches.get(context);
  if (!cache) { cache = { evaluate: createPageAccessEvaluator(context.policy(context.payload, context.saved.principals, context.workspaceId)), decisions: new Map() }; requestAccessCaches.set(context, cache); }
  const key = accountId + '/' + pageId;
  if (!cache.decisions.has(key)) cache.decisions.set(key, cache.evaluate({ accountId, workspaceId: context.workspaceId, pageId }).capabilities);
  return cache.decisions.get(key);
}
function authorizedMentions(context, value, body) {
  mentions(value, body, false);
  return value.map(item => {
    const principal = context.saved.principals.find(row => row.accountId === item.accountId && row.emailVerified);
    if (!principal || !accessFor(context, item.accountId, context.pageId).includes('read')) missing();
    return { ...item, membershipId: principal.id };
  });
}
function projectThread(context, thread) {
  const page = context.payload.pages.find(item => item.page.id === thread.pageId);
  const blockId = thread.blockId !== null && blockExists(page.document.blocks, thread.blockId) ? thread.blockId : null;
  return { id: thread.id, pageId: thread.pageId, blockId, anchorMissing: thread.blockId !== null && blockId === null, createdAt: thread.createdAt, updatedAt: thread.updatedAt, resolvedAt: thread.resolvedAt,
    canResolve: context.access(thread.pageId).includes('comment') && (context.access(thread.pageId).includes('manage') || thread.messages[0].authorId === context.accountId && thread.messages[0].authorMembershipId === context.actor.id),
    messages: thread.messages.map(message => ({ id: message.id, authorId: message.authorId, text: message.text, createdAt: message.createdAt, updatedAt: message.updatedAt, deletedAt: message.deletedAt,
      canEdit: context.access(thread.pageId).includes('comment') && message.deletedAt === null && message.authorId === context.accountId && message.authorMembershipId === context.actor.id,
      canDelete: context.access(thread.pageId).includes('comment') && message.deletedAt === null && (context.access(thread.pageId).includes('manage') || message.authorId === context.accountId && message.authorMembershipId === context.actor.id),
      mentions: message.mentions.filter(item => context.saved.principals.some(row => row.accountId === item.accountId && row.id === item.membershipId && row.emailVerified) && accessFor(context, item.accountId, thread.pageId).includes('read')).map(({ accountId, start, end }) => ({ accountId, start, end })) })) };
}
function mint(context) {
  const id = assertId(context.createId()), discussion = context.payload.discussion;
  if (discussion.threads.some(thread => thread.id === id || thread.messages.some(message => message.id === id)) || discussion.notifications.some(item => item.id === id)||(context.payload.activityNotifications??[]).some(item=>item.id===id)) fail('CONTENT_UNAVAILABLE', 503);
  return id;
}
function updateNotifications(context, thread, message, {created=false}={}) {
  const discussion=context.payload.discussion,people=new Map(context.saved.principals.filter(person=>person.emailVerified).map(person=>[person.accountId,person]));
  const live=(accountId,membershipId)=>{const person=people.get(accountId);return person&&person.accountId!==message.authorId&&person.id===membershipId&&accessFor(context,accountId,thread.pageId).includes('read')?person:null;};
  // A prior author remains subscribed after their text is tombstoned, but never across membership generations.
  const replies=new Map();for(const prior of thread.messages.slice(0,thread.messages.indexOf(message))){const person=live(prior.authorId,prior.authorMembershipId);if(person)replies.set(person.accountId,person);}
  const mentioned=new Map();for(const mention of message.mentions){const person=live(mention.accountId,mention.membershipId);if(person)mentioned.set(person.accountId,person);}
  discussion.notifications=discussion.notifications.filter(item=>item.messageId!==message.id||message.deletedAt===null&&live(item.recipientId,item.recipientMembershipId)&&(item.reason==='reply'?replies.get(item.recipientId)?.id===item.recipientMembershipId:mentioned.get(item.recipientId)?.id===item.recipientMembershipId));
  if(message.deletedAt!==null)return[];
  // Editing preserves existing reply IDs/read state and never adds automatic recipients retroactively.
  const wanted=new Map(created?[...replies].map(([accountId,person])=>[accountId,{person,reason:'reply'}]):[]);
  for(const[accountId,person]of mentioned)if(!wanted.has(accountId))wanted.set(accountId,{person,reason:'mention'});
  for(const{person,reason}of wanted.values())if(!discussion.notifications.some(item=>item.messageId===message.id&&item.recipientId===person.accountId))discussion.notifications.push({id:mint(context),pageId:thread.pageId,threadId:thread.id,messageId:message.id,recipientId:person.accountId,recipientMembershipId:person.id,createdAt:context.now(),readAt:null,reason});
  const guards=new Map();for(const item of discussion.notifications.filter(item=>item.messageId===message.id)){const person=people.get(item.recipientId);guards.set(person.id,{id:person.id,accountId:person.accountId,role:person.role});}
  if(guards.size>16)fail('COMMENTS_TOO_LARGE',413);return[...guards.values()];
}
function notificationList(context) {
  const discussion = context.payload.discussion;
  return (discussion?.notifications ?? []).filter(item => item.recipientId === context.accountId && item.recipientMembershipId === context.actor.id && context.access(item.pageId).includes('read')).map(item => {
    const page = context.payload.pages.find(row => row.page.id === item.pageId), thread = discussion.threads.find(row => row.id === item.threadId), message = thread.messages.find(row => row.id === item.messageId);
    return { id: item.id, pageId: item.pageId, pageTitle: page.page.title, threadId: item.threadId, messageId: item.messageId, authorId: message.authorId, text: message.text.slice(0, 500), createdAt: item.createdAt, readAt: item.readAt, reason:item.reason??'mention' };
  }).reverse().concat(assignmentNotifications(context).reverse(),inlineMentionNotifications(context).reverse()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
async function commit(context, guards, result, authorizeFresh) {
  const captured = context.validatePayload(context.payload, context.workspaceId);
  try {
    const written = await context.store.write(context.workspaceId, context.accountId, { expectedRevision: context.saved.revision, payload: captured, actorMembershipId: context.actor.id, actorRole: context.actor.role, guardMemberships: guards });
    return Response.json({ revision: written.revision, ...result }, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch (error) {
    if (error?.code !== 'CONTENT_CONFLICT') throw error;
    const saved = await context.store.read(context.workspaceId, context.accountId), actor = saved?.principals.find(row => row.accountId === context.accountId && row.id === context.actor.id && row.role === context.actor.role && row.emailVerified);
    if (!actor) missing();
    const payload = context.readPayload(saved, context.workspaceId), evaluate = createPageAccessEvaluator(context.policy(payload, saved.principals, context.workspaceId));
    const fresh = { ...context, saved, payload, actor, access: id => evaluate({ accountId: context.accountId, workspaceId: context.workspaceId, pageId: id }).capabilities };
    authorizeFresh(fresh); conflict();
  }
}
export async function handleDiscussion(context) {
  const { request, pageId, threadId, messageId, action, payload, saved, accountId, actor } = context;
  const json = value => Response.json(value, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  if (action === 'notifications') {
    const notifications = notificationList(context);
    if (request.method === 'GET') return json({ revision: saved.revision, notifications });
    if (request.method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
    const body = await context.readJson(request); exact(body, ['expectedRevision', 'notificationIds']); revision(body.expectedRevision);
    if (!Array.isArray(body.notificationIds) || !body.notificationIds.length || body.notificationIds.length > 100 || new Set(body.notificationIds).size !== body.notificationIds.length) fail();
    if (body.notificationIds.some(id => !notifications.some(item => item.id === id))) missing(); if (body.expectedRevision !== saved.revision) conflict();
    for (const item of [...(payload.discussion?.notifications??[]),...(payload.activityNotifications??[])]) if (body.notificationIds.includes(item.id) && item.readAt === null) item.readAt = context.now();
    return commit(context, [], { read: body.notificationIds.length }, fresh => { if (body.notificationIds.some(id => !notificationList(fresh).some(item => item.id === id))) missing(); });
  }
  const page = payload.pages.find(item => item.page.id === pageId);
  if (!page || !context.access(pageId).includes('read')) missing();
  if (action === 'people') {
    if (request.method !== 'GET') fail('METHOD_NOT_ALLOWED', 405);
    return json({ revision: saved.revision, pageId, people: saved.principals.filter(item => item.emailVerified && accessFor(context, item.accountId, pageId).includes('read')).map(item => ({ accountId: item.accountId, name: item.displayName || item.accountId })) });
  }
  const thread = (payload.discussion?.threads ?? []).find(item => item.pageId === pageId && item.id === threadId);
  if (request.method === 'GET') {
    if (messageId || action !== 'comments') fail('METHOD_NOT_ALLOWED', 405);
    if (threadId && !thread) missing();
    return json({ revision: saved.revision, pageId, canComment: context.access(pageId).includes('comment'), threads: (threadId ? [thread] : payload.discussion?.threads ?? []).filter(item => item.pageId === pageId).map(item => projectThread(context, item)) });
  }
  if (!context.access(pageId).includes('comment')) missing();
  const body = await context.readJson(request); revision(body?.expectedRevision);
  if (threadId && !thread) missing();
  const ownsThread = thread && (thread.messages[0].authorId === accountId && thread.messages[0].authorMembershipId === actor.id || context.access(pageId).includes('manage'));
  if (action === 'resolve' && (!thread || !ownsThread || request.method !== 'PATCH')) missing();
  const message = thread?.messages.find(item => item.id === messageId);
  if (messageId && (!message || message.deletedAt !== null || !(message.authorId === accountId && message.authorMembershipId === actor.id || request.method === 'DELETE' && context.access(pageId).includes('manage')))) missing();
  if (body.expectedRevision !== saved.revision) conflict();
  payload.discussion ??= { threads: [], notifications: [] }; let guards = [], result;
  if (action === 'resolve') {
    if (!thread || !ownsThread || request.method !== 'PATCH') missing(); exact(body, ['expectedRevision', 'resolved']); if (typeof body.resolved !== 'boolean') fail();
    thread.resolvedAt = body.resolved ? context.now() : null; thread.updatedAt = context.now(); result = { thread: projectThread(context, thread) };
  } else if (messageId) {
    if (!['PATCH', 'DELETE'].includes(request.method)) fail('METHOD_NOT_ALLOWED', 405);
    if (request.method === 'DELETE') { exact(body, ['expectedRevision']); message.text = ''; message.mentions = []; message.deletedAt = context.now(); }
    else { exact(body, ['expectedRevision', 'text', 'mentions']); text(body.text); message.mentions = authorizedMentions(context, body.mentions, body.text); message.text = body.text; }
    message.updatedAt = context.now(); thread.updatedAt = context.now(); guards=updateNotifications(context, thread, message); result = { thread: projectThread(context, thread) };
  } else {
    if (request.method !== 'POST' || action !== 'comments') fail('METHOD_NOT_ALLOWED', 405);
    exact(body, thread ? ['expectedRevision', 'text', 'mentions'] : ['expectedRevision', 'text', 'mentions', 'blockId']); text(body.text);
    if (thread?.resolvedAt !== null && thread) fail('COMMENT_THREAD_RESOLVED', 409);
    if (!thread && body.blockId !== null && (!blockExists(page.document.blocks, assertId(body.blockId)))) missing();
    const selected = thread ?? { id: mint(context), pageId, blockId: body.blockId, createdAt: context.now(), updatedAt: context.now(), resolvedAt: null, messages: [] };
    if (!thread) payload.discussion.threads.push(selected);
    const bound = authorizedMentions(context, body.mentions, body.text);
    const created = { id: mint(context), authorId: accountId, authorMembershipId: actor.id, text: body.text, mentions: bound, createdAt: context.now(), updatedAt: context.now(), deletedAt: null };
    selected.messages.push(created); selected.updatedAt = context.now(); guards=updateNotifications(context, selected, created,{created:true}); result = { thread: projectThread(context, selected) };
  }
  if (size(payload.discussion) > limits.bytes || payload.discussion.threads.length > limits.threads || payload.discussion.threads.reduce((count, item) => count + item.messages.length, 0) > limits.messages || payload.discussion.notifications.length > limits.notifications) fail('COMMENTS_TOO_LARGE', 413);
  return commit(context, guards, result, fresh => {
    if (!fresh.access(pageId).includes('comment')) missing();
    if (guards.some(guard => !fresh.saved.principals.some(row => row.id === guard.id && row.accountId === guard.accountId && row.role === guard.role && row.emailVerified) || !accessFor(fresh, guard.accountId, pageId).includes('read'))) missing();
    if (action === 'resolve' || messageId) {
      const current = fresh.payload.discussion?.threads.find(item => item.id === threadId && item.pageId === pageId), author = messageId ? current?.messages.find(item => item.id === messageId) : current?.messages[0];
      if (!author || !(author.authorId === accountId && author.authorMembershipId === fresh.actor.id || (action === 'resolve' || request.method === 'DELETE') && fresh.access(pageId).includes('manage'))) missing();
    }
  });
}
