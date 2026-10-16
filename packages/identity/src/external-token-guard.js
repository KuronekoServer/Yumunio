import {assertId,assertJsonSerializable,assertPlainObject} from '@yumunio/domain';
import {tokenScopes,tokenTimestamp,validateTokenRow} from './api-token-model.js';

const keys=['id','tokenHash','version','accountId','workspaceId','pageId','membershipId','actorRole','scopes','now'];
/** Private, credential-derived commit fence. Never accept this descriptor from HTTP input. */
export function createExternalTokenGuard(value,{now,requiredScopes=[]}={}) {
 const row=validateTokenRow(value);tokenTimestamp(now);
 if(!Array.isArray(requiredScopes)||!requiredScopes.every(scope=>row.scopes.includes(scope))||!row.scopes.includes('document:write'))throw Error('Invalid external token guard.');
 return Object.fromEntries(keys.map(key=>[key,key==='now'?now:structuredClone(row[key])]));
}
function checked(value,context){
 assertPlainObject(value);assertJsonSerializable(value);
 if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||!/^([a-f0-9]{32})$/.test(value.id)||!/^[a-f0-9]{64}$/.test(value.tokenHash)||!Number.isSafeInteger(value.version)||value.version<1)throw Error('Invalid external token guard.');
 for(const key of ['accountId','workspaceId','pageId','membershipId'])assertId(value[key]);
 tokenTimestamp(value.now);tokenScopes(value.scopes);
 if(!value.scopes.includes('document:write')||value.accountId!==context.accountId||value.workspaceId!==context.workspaceId||value.membershipId!==context.actorMembershipId||value.actorRole!==context.actorRole)throw Error('Invalid external token guard.');
 return value;
}
/** Same statement as aggregate CAS, including database time after any awaited preparation. */
export function externalTokenGuardSql(s,dialect,input,context){
 const value=checked(input,context),b=s.bind,e=s.equal;
 const clock=dialect==='sqlite'?"strftime('%Y-%m-%dT%H:%M:%fZ','now')":dialect==='postgres'?"to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')":"CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%f'),23),'Z')";
 return 'EXISTS (SELECT 1 FROM yumunio_api_tokens external_token WHERE '+
  [['id',value.id],['token_hash',value.tokenHash],['account_id',value.accountId],['workspace_id',value.workspaceId],['page_id',value.pageId],['membership_id',value.membershipId],['actor_role',value.actorRole],['scopes_json',JSON.stringify(value.scopes)]].map(([column,item])=>e('external_token.'+column,b(item))).join(' AND ')+
  ' AND external_token.version = '+b(value.version)+' AND external_token.revoked_at IS NULL AND external_token.active_slot IS NOT NULL AND external_token.expires_at > '+b(value.now)+' AND external_token.expires_at > '+clock+')';
}
