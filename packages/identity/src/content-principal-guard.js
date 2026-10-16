import {assertId} from '@yumunio/domain';
/** Internal complete live-principal fence, with four bound values regardless of roster size. */
export function principalSnapshotGuardSql(s,dialect,workspaceId,principals){
 assertId(workspaceId);if(!['sqlite','mysql','postgres'].includes(dialect)||!Array.isArray(principals)||principals.length>1000)throw Error('Invalid principal snapshot.');
 const seen=new Set(),snapshot=principals.map(person=>{if(!person||typeof person.emailVerified!=='boolean'||!['owner','admin','member','guest'].includes(person.role)||seen.has(person.accountId))throw Error('Invalid principal snapshot.');seen.add(person.accountId);assertId(person.id);assertId(person.accountId);return[person.id,person.accountId,person.role,person.emailVerified?'1':'0'].join('\u001f');});
 const delimiter=dialect==='postgres'?'chr':'char',column=name=>s.column('ps',name),fields=[column('id'),delimiter+'(31)',column('userId'),delimiter+'(31)',column('role'),delimiter+'(31)','CASE WHEN '+s.column('pu','emailVerified')+" = TRUE THEN '1' ELSE '0' END"];
 const row=dialect==='mysql'?'CONCAT('+delimiter+'(30),'+fields.join(',')+','+delimiter+'(30))':delimiter+'(30)||'+fields.join('||')+'||'+delimiter+'(30)';
 let sql='((SELECT COUNT(*) FROM yumunio_memberships pc JOIN yumunio_users pcu ON '+s.equal(s.column('pcu','id'),s.column('pc','userId'))+' WHERE '+s.equal(s.column('pc','organizationId'),s.bind(workspaceId))+') = '+s.bind(snapshot.length);
 sql+=' AND NOT EXISTS (SELECT 1 FROM yumunio_memberships ps JOIN yumunio_users pu ON '+s.equal(s.column('pu','id'),column('userId'))+' WHERE '+s.equal(column('organizationId'),s.bind(workspaceId))+' AND ';
 const packed=s.bind('\u001e'+snapshot.join('\u001e')+'\u001e'),contains=dialect==='mysql'?'LOCATE(BINARY '+row+', BINARY '+packed+')':dialect==='postgres'?'strpos('+packed+','+row+')':'instr('+packed+','+row+')';
 return sql+contains+' = 0))';
}
