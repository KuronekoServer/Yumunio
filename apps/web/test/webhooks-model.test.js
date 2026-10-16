import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWebhookConfig,validateWebhookSubscription,validateWebhookDeliveries,webhookNeedsGapAcknowledgement,buildWebhookSubscriptionRequest,readWebhookJson} from '../public/webhooks-model.js';
const profile={label:'Team webhook',endpointOrigin:'https://receiver.example.invalid',profileDigest:'a'.repeat(64)},stamp='2026-10-15T00:00:00.000Z',id='11111111-1111-4111-8111-111111111111';
const config=()=>({enabled:true,canApprove:false,profile:structuredClone(profile),eventTypes:['page.updated'],limits:{pending:1000,metadata:10000,attempts:4},approval:{version:1,approved:true}});
const status=()=>({revision:5,pageVersion:3,profile:structuredClone(profile),approval:{version:1,approved:true},subscription:{id,status:'paused',reason:'capacity',version:2,startVersion:1,missedFromVersion:2,missedThroughVersion:3,gapAcknowledgedAt:null},canManage:true});
const job=()=>({eventId:id,eventType:'page.updated',pageVersion:3,occurredAt:stamp,status:'queued',attempts:0,nextAttemptAt:stamp,lastCode:null,version:1});
test('Webhook config exposes only a fixed HTTPS origin/label/profile hash and rejects secrets or endpoint paths',()=>{
 const value=validateWebhookConfig(config());assert.equal(value.profile.endpointOrigin,profile.endpointOrigin);value.profile.label='changed';assert.equal(profile.label,'Team webhook');assert.deepEqual(validateWebhookConfig({...config(),enabled:false,profile:null,approval:null}).profile,null);
 for(const alter of [value=>value.profile.endpoint='https://receiver.example.invalid/private',value=>value.profile.signingKey='secret',value=>value.profile.endpointOrigin+='/',value=>value.profile.endpointOrigin='https://receiver.example.invalid/path',value=>value.profile.endpointOrigin='https://user:pass@receiver.example.invalid',value=>value.profile.endpointOrigin='http://receiver.example.invalid',value=>value.eventTypes.push('page.content'),value=>value.approval.approvedBy='private-admin',value=>value.limits.rawCount=2]){const value=config();alter(value);assert.throws(()=>validateWebhookConfig(value));}
});
test('Webhook subscription drafts bind the reviewed profile and CAS and require explicit metadata and missing-range consent',()=>{
 const value=validateWebhookSubscription(status(),{profile});assert.equal(webhookNeedsGapAcknowledgement(value),true);for(const options of [{},{confirmMetadataTransfer:true},{confirmMetadataTransfer:true,acknowledgeMissing:true,profileDigest:'b'.repeat(64)}])assert.throws(()=>buildWebhookSubscriptionRequest(value,{profileDigest:profile.profileDigest,...options}));
 const body=buildWebhookSubscriptionRequest(value,{profileDigest:profile.profileDigest,confirmMetadataTransfer:true,acknowledgeMissing:true});assert.deepEqual(body,{expectedRevision:5,expectedVersion:2,profileDigest:profile.profileDigest,confirmMetadataTransfer:true,acknowledgeMissing:true});assert.equal(Object.hasOwn(body,'endpoint'),false);
 const first={...value,subscription:null};assert.equal(buildWebhookSubscriptionRequest(first,{profileDigest:profile.profileDigest,confirmMetadataTransfer:true}).expectedVersion,0);const restored={...value,subscription:{...value.subscription,reason:'restore',missedFromVersion:null,missedThroughVersion:null}};assert.equal(webhookNeedsGapAcknowledgement(restored),true);assert.throws(()=>buildWebhookSubscriptionRequest(restored,{profileDigest:profile.profileDigest,confirmMetadataTransfer:true}));
 for(const mutate of [value=>value.approval.approved=false,value=>value.subscription.status='active']){const changed=status();mutate(changed);assert.throws(()=>buildWebhookSubscriptionRequest(changed,{profileDigest:profile.profileDigest,confirmMetadataTransfer:true,acknowledgeMissing:true}));}
});
test('Webhook status and jobs reject unknown fields, profile changes, reversed gaps and provider response leakage',()=>{
 for(const alter of [value=>value.subscription.issuerAccountId='private',value=>value.canManage=false,value=>value.subscription.missedThroughVersion=1,value=>value.subscription.gapAcknowledgedAt='invalid',value=>value.profile.profileDigest='b'.repeat(64)]){const value=status();alter(value);assert.throws(()=>validateWebhookSubscription(value,{profile}));}
 const envelope={revision:5,subscriptionId:id,deliveries:[job()]};assert.equal(validateWebhookDeliveries(envelope).deliveries[0].status,'queued');assert.equal(validateWebhookDeliveries({...envelope,deliveries:[{...job(),status:'failed',lastCode:'INTEGRITY'}]}).deliveries[0].lastCode,'INTEGRITY');
 for(const alter of [value=>value.deliveries[0].payloadJson='private',value=>value.deliveries[0].lastCode='provider response with secret',value=>value.deliveries[0].attempts=5,value=>value.deliveries.push(job()),value=>value.subscriptionId=null]){const value=structuredClone(envelope);alter(value);assert.throws(()=>validateWebhookDeliveries(value));}
});
test('Webhook JSON is bounded, requires valid UTF8 JSON and never renders raw unknown provider responses',async()=>{
 assert.deepEqual(await readWebhookJson(Response.json({safe:true})),{safe:true});await assert.rejects(readWebhookJson(Response.json({text:'x'.repeat(40)}),{maxBytes:20}));await assert.rejects(readWebhookJson(new Response('<html>private</html>',{headers:{'Content-Type':'text/html'}})));await assert.rejects(readWebhookJson(new Response(new Uint8Array([0xff]),{headers:{'Content-Type':'application/json'}})));
});

test('configured detail-event subsets validate while unknown, duplicate and unordered sets are rejected',()=>{
 const base={enabled:true,canApprove:true,profile:{label:'Fixture',endpointOrigin:'https://hooks.example.invalid',profileDigest:'a'.repeat(64)},eventTypes:['page.updated'],limits:{pending:1000,metadata:10000,attempts:4},approval:{version:1,approved:true}};
 for(const eventTypes of [['page.title.updated'],['page.document.updated'],['page.updated','page.title.updated','page.document.updated']])assert.deepEqual(validateWebhookConfig({...base,eventTypes}).eventTypes,eventTypes);
 for(const eventTypes of [[],['page.deleted'],['page.updated','page.updated'],['page.document.updated','page.title.updated']])assert.throws(()=>validateWebhookConfig({...base,eventTypes}));
});

test('lifecycle scope is reviewed explicitly and unknown-size capacity gaps still require acknowledgement',()=>{
 const cfg=config();cfg.eventTypes=['page.created','page.moved','page.trashed','page.restored'];cfg.profile.includeDescendants=true;assert.deepEqual(validateWebhookConfig(cfg).eventTypes,cfg.eventTypes);
 const value=status();value.profile.includeDescendants=true;value.subscription.missedFromVersion=null;value.subscription.missedThroughVersion=null;
 assert.equal(webhookNeedsGapAcknowledgement(value),true);
 const options={profileDigest:profile.profileDigest,confirmMetadataTransfer:true,acknowledgeMissing:true};
 assert.throws(()=>buildWebhookSubscriptionRequest(value,options));
 assert.equal(buildWebhookSubscriptionRequest(value,{...options,confirmDescendants:true}).confirmDescendants,true);
 assert.throws(()=>validateWebhookSubscription(value,{profile}));
 for(const altered of [{...cfg,profile:{...cfg.profile,includeDescendants:false}},{...cfg,eventTypes:['page.created','page.created']}])assert.throws(()=>validateWebhookConfig(altered));
 for(const eventType of cfg.eventTypes)assert.equal(validateWebhookDeliveries({revision:5,subscriptionId:id,deliveries:[{...job(),eventType}]}).deliveries[0].eventType,eventType);
});
