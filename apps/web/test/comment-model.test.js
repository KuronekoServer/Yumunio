import test from 'node:test';
import assert from 'node:assert/strict';
import { updateMentionRanges, appendMention,validateInbox,notificationHref } from '../public/comment-model.js';
test('mentions follow edits before and after their labels, while edits inside a label remove the binding', () => {
  const original='Hello @猫 さん', mentions=[{accountId:'cat',start:6,end:8}];
  assert.deepEqual(updateMentionRanges(original,'New '+original,mentions),[{accountId:'cat',start:10,end:12}]);
  assert.deepEqual(updateMentionRanges(original,original+'!',mentions),mentions);
  assert.deepEqual(updateMentionRanges(original,'Hello @犬 さん',mentions),[]);
  assert.deepEqual(updateMentionRanges(original,'Hello さん',mentions),[]);
  assert.deepEqual(updateMentionRanges(original,'@猫 さん',mentions),[{accountId:'cat',start:0,end:2}]);
});
test('inserting a person creates an explicit plain text range without implicit mention parsing or duplicate recipients', () => {
  const draft=appendMention({text:'Hi',mentions:[]},{accountId:'a',name:'猫 🐈'});
  assert.equal(draft.text,'Hi @猫 🐈 ');assert.equal(draft.text.slice(draft.mentions[0].start,draft.mentions[0].end),'@猫 🐈');
  assert.deepEqual(appendMention(draft,{accountId:'a',name:'Different'}),draft);
  assert.equal(draft.mentions.length,1);
});

const notice={id:'assignment-1',pageId:'row-page',pageTitle:'Literal <record>',authorId:'author',createdAt:'2026-10-16T00:00:00.000Z',readAt:null,reason:'assignment'};
test('assignment inbox links open only the readable record and never synthesize a comment thread or container',()=>{
 const inbox=validateInbox({revision:4,notifications:[notice]});assert.deepEqual(inbox.notifications[0],notice);assert.equal(notificationHref('workspace',notice),'/workspace.html?workspace=workspace&page=row-page');
 const comment={...notice,reason:'reply',threadId:'thread',messageId:'message',text:'Reply'};assert.match(notificationHref('workspace',comment),/^\/comments.html\?workspace=workspace&page=row-page#thread-thread$/);delete comment.reason;assert.equal(validateInbox({revision:1,notifications:[comment]}).notifications[0].reason,'mention');
});
test('inbox rejects mixed or unknown metadata, malformed identities and duplicate notifications before display',()=>{
 for(const value of [{...notice,threadId:'hidden-thread'},{...notice,collectionId:'hidden-container'},{...notice,text:'Private snippet'},{...notice,pageId:'javascript:alert(1)'},{...notice,readAt:'yesterday'},{...notice,reason:'unknown'}])assert.throws(()=>validateInbox({revision:1,notifications:[value]}),{code:'INVALID_NOTIFICATIONS'});
 assert.throws(()=>validateInbox({revision:1,notifications:[notice,notice]}),{code:'INVALID_NOTIFICATIONS'});assert.throws(()=>notificationHref('not/a/workspace',notice),{code:'INVALID_NOTIFICATIONS'});
 for(const key of ['pageTitle','reason']){const accessors={...notice};Object.defineProperty(accessors,key,{enumerable:true,get(){throw Error('must not read accessor');}});assert.throws(()=>validateInbox({revision:1,notifications:[accessors]}),{code:'INVALID_NOTIFICATIONS'});}
});

test('inline person mention notifications open the current page using only the minimal page reference',()=>{
 const mention={...notice,id:'inline-mention-1',reason:'inline-mention'};
 assert.deepEqual(validateInbox({revision:9,notifications:[notice,mention]}).notifications,[notice,mention]);
 assert.equal(notificationHref('workspace',mention),'/workspace.html?workspace=workspace&page=row-page');
 for(const extra of [{text:'Private body'},{threadId:'thread'},{blockId:'block'},{recipientId:'account'},{recipientMembershipId:'generation'},{collectionId:'collection'}])assert.throws(()=>validateInbox({revision:9,notifications:[{...mention,...extra}]}),{code:'INVALID_NOTIFICATIONS'});
 const withoutReason={...mention};delete withoutReason.reason;assert.throws(()=>validateInbox({revision:9,notifications:[withoutReason]}),{code:'INVALID_NOTIFICATIONS'});
});
