import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountImportFlow, ImportFlowError } from '../public/import-flow.js';
import { prepareNotionImportBundle, buildNotionImportBundle } from '../../../packages/importer/src/apply-plan.js';

function fixture() {
  const markdown = '# Fictional page\n\n[CSV](Table.csv)', csv = 'Name\nRen\n';
  const sizes = [new TextEncoder().encode(markdown).length, new TextEncoder().encode(csv).length, 3];
  return { schemaVersion: 1, source: 'notion-markdown-csv',
    summary: { entries: 3, pages: 1, collections: 1, records: 1, attachments: 1, links: 1, unresolvedLinks: 0, matchingCandidates: 0, unsupported: 0, archiveBytes: 300, uncompressedBytes: sizes.reduce((a,b)=>a+b,0) },
    warnings: [], entries: [
      { id: 'entry-1', path: 'Page.md', kind: 'page', bytes: sizes[0], modelId: 'page-1' },
      { id: 'entry-2', path: 'Table.csv', kind: 'collection', bytes: sizes[1], modelId: 'collection-1' },
      { id: 'entry-3', path: 'image.png', kind: 'attachment', bytes: sizes[2] }
    ],
    pages: [{ id: 'page-1', entryId: 'entry-1', title: 'Fictional page', sourceMarkdown: markdown,
      blocks: [{ id: 'block-1', kind: 'heading', text: 'Fictional page', level: 1 }, { id: 'block-2', kind: 'paragraph', text: '[CSV](Table.csv)' }],
      propertyCandidates: [], parentCandidateId: null }],
    collections: [{ id: 'collection-1', entryId: 'entry-2', title: 'Table', columns: [{ id: 'column-1', name: 'Name', type: 'text', confirmed: false }],
      rows: [{ id: 'row-1', cells: ['Ren'] }] }],
    links: [{ id: 'link-1', sourceId: 'page-1', label: 'CSV', image: false, kind: 'collection', targetId: 'collection-1' }], matches: [], unsupported: [] };
}
const actor = { id: 'account-A', emailVerified: true };
const acks = { csvReference: true, linksUnconverted: true, excludedAssets: true };
const metadata = (workspaceId = 'workspace-A', revision = 0, role = 'member') => ({ workspaceId, revision, role, pages: [] });
function harness(handler) {
  const requests = []; let ids = 0;
  const flow = new AccountImportFlow({ prepare: prepareNotionImportBundle, build: buildNotionImportBundle, createId: () => 'import-fixed-' + (++ids),
    fetcher: async (path, options) => { requests.push({ path, options }); return handler(path, options, requests); } });
  flow.setActor(actor);
  return { flow, requests, posts: () => requests.filter(item=>item.options.method==='POST'), ids: () => ids };
}
async function reviewed(flow, plan = fixture()) {
  await flow.selectWorkspace({ id: 'workspace-A', name: 'Fictional workspace' });
  return flow.prepare(plan, 'Fictional private folder', { csvMode: 'reference' });
}
const success = body => ({ revision: 1, importId: body.importId, rootPageId: 'created-root', pageCount: body.pages.length, replayed: false });

test('review and loss acknowledgements gate a single account-scoped atomic request', async () => {
  const h = harness((path, options) => path.endsWith('/get-session') ? Response.json({ user: actor }) :
    options.method === 'POST' ? Response.json(success(JSON.parse(options.body)), { status: 201 }) : Response.json(metadata()));
  const prepared = await reviewed(h.flow);
  assert.equal(prepared.body.pages.length, 3);
  assert.deepEqual(prepared.requiredAcknowledgements, ['csvReference','linksUnconverted','excludedAssets']);
  assert.equal(prepared.body.pages[1].blocks[0].type, 'heading');
  assert.equal(prepared.body.pages[1].blocks[0].data.level, 1);
  assert.equal(prepared.body.pages[1].blocks.at(-1).data.purpose, 'import-source');
  await assert.rejects(h.flow.submit({ acknowledgements: acks }), /ACKNOWLEDGEMENT_REQUIRED/);
  await assert.rejects(h.flow.submit({ acknowledgements: { csvReference: true }, consent: true }), /ACKNOWLEDGEMENT_REQUIRED/);
  assert.equal(h.posts().length, 0);
  await h.flow.submit({ acknowledgements: acks, consent: true });
  assert.equal(h.posts().length, 1);
  const request = h.posts()[0];
  assert.equal(request.path, '/api/content/workspaces/workspace-A/imports');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.mode, 'same-origin');
  assert.equal(request.options.headers['X-Yumunio-Expected-Account'], actor.id);
  assert.equal('snapshot' in JSON.parse(request.options.body), false);
});

test('an uncertain network result keeps file-derived content and retries the identical ID and body', async () => {
  let posted = 0, serverRevision = 0;
  const h = harness((path, options) => {
    if (path.endsWith('/get-session')) return Response.json({ user: actor });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); serverRevision = 1;
      if (++posted === 1) throw new TypeError('Simulated response loss after commit');
      return Response.json({ ...success(body), replayed: true });
    }
    return Response.json(metadata('workspace-A', serverRevision));
  });
  const original = fixture(); await reviewed(h.flow, original);
  const before = JSON.stringify(h.flow.body);
  await assert.rejects(h.flow.submit({ acknowledgements: acks, consent: true }), /NETWORK_UNCERTAIN/);
  assert.equal(h.flow.phase, 'uncertain'); assert.equal(h.posts().length, 1);
  assert.throws(() => h.flow.invalidate(), /IMPORT_LOCKED/);
  assert.throws(() => h.flow.setActor({ id: 'account-B', emailVerified: true }), /ACCOUNT_CHANGED/);
  h.flow.setActor(actor);
  const result = await h.flow.submit({ acknowledgements: acks, consent: true });
  assert.equal(result.replayed, true); assert.equal(h.ids(), 1);
  assert.equal(h.posts()[0].options.body, h.posts()[1].options.body);
  assert.equal(JSON.stringify(h.flow.body), before);
  assert.equal(h.posts()[1].options.headers['X-Yumunio-Expected-Account'], actor.id);
  assert.equal(original.pages[0].sourceMarkdown, fixture().pages[0].sourceMarkdown);
});

test('409 stops resubmission until explicit destination recheck, preserving pages and import ID', async () => {
  let serverRevision = 0, posted = 0;
  const h = harness((path, options) => {
    if (path.endsWith('/get-session')) return Response.json({ user: actor });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (++posted === 1) { serverRevision = 2; return Response.json({ error: { code: 'CONTENT_CONFLICT' } }, { status: 409 }); }
      return Response.json({ ...success(body), revision: 3 });
    }
    return Response.json(metadata('workspace-A', serverRevision));
  });
  await reviewed(h.flow); const before = structuredClone(h.flow.body);
  await assert.rejects(h.flow.submit({ acknowledgements: acks, consent: true }), /CONTENT_CONFLICT/);
  await assert.rejects(h.flow.submit({ acknowledgements: acks, consent: true }), /IMPORT_REVIEW_REQUIRED/);
  assert.equal(h.posts().length, 1);
  await h.flow.recheckConflict();
  assert.equal(h.flow.body.expectedRevision, 2);
  assert.equal(h.flow.body.importId, before.importId);
  assert.deepEqual(h.flow.body.pages, before.pages);
  await assert.rejects(h.flow.submit({ consent: false }), /ACKNOWLEDGEMENT_REQUIRED/);
  await h.flow.submit({ acknowledgements: acks, consent: true }); assert.equal(h.posts().length, 2);
});

test('an account switch before submission never sends import content', async () => {
  const h = harness(path => path.endsWith('/get-session') ? Response.json({ user: { id: 'account-B', emailVerified: true } }) : Response.json(metadata()));
  await reviewed(h.flow);
  await assert.rejects(h.flow.submit({ acknowledgements: acks, consent: true }), /ACCOUNT_CHANGED/);
  assert.equal(h.posts().length, 0); assert.equal(h.flow.phase, 'account-changed');
});

test('the expected-account guard stays bound to A when a cookie changes to B after preflight', async () => {
  let trustedSession = actor;
  const h = harness((path, options) => {
    if (path.endsWith('/get-session')) { const captured = trustedSession; trustedSession = { id: 'account-B', emailVerified: true }; return Response.json({ user: captured }); }
    if (options.method === 'POST') {
      assert.equal(options.headers['X-Yumunio-Expected-Account'], actor.id);
      assert.notEqual(options.headers['X-Yumunio-Expected-Account'], trustedSession.id);
      return Response.json({ error: { code: 'CONTENT_NOT_FOUND' } }, { status: 404 });
    }
    return Response.json(metadata());
  });
  await reviewed(h.flow); const before = JSON.stringify(h.flow.body);
  await assert.rejects(h.flow.submit({ acknowledgements: acks, consent: true }), /CONTENT_NOT_FOUND/);
  assert.equal(h.flow.phase, 'forbidden'); assert.equal(h.flow.result, null);
  assert.equal(JSON.stringify(h.flow.body), before);
});

test('guests and unverified users cannot prepare an import', async () => {
  const h = harness(()=>Response.json(metadata('workspace-A',0,'guest')));
  await assert.rejects(h.flow.selectWorkspace({ id:'workspace-A',name:'Shared workspace' }),/GUEST_IMPORT_FORBIDDEN/);
  assert.equal(h.flow.workspace,null); assert.equal(h.posts().length,0);
  const unverified = harness(()=>{ throw new Error('No request should run'); });
  unverified.flow.setActor({id:'account-A',emailVerified:false});
  await assert.rejects(unverified.flow.selectWorkspace({id:'workspace-A',name:'Workspace'}),/VERIFIED_ACCOUNT_REQUIRED/);
  assert.equal(unverified.requests.length,0);
});

test('a delayed metadata response cannot replace the workspace selected later', async () => {
  let release;
  const h = harness(path => path.includes('workspace-A') ? new Promise(resolve=>{release=()=>resolve(Response.json(metadata()));}) : Response.json(metadata('workspace-B')));
  const first = h.flow.selectWorkspace({id:'workspace-A',name:'First'});
  await h.flow.selectWorkspace({id:'workspace-B',name:'Second'}); release(); await first;
  assert.equal(h.flow.workspace.id,'workspace-B');
  assert.equal(h.flow.workspace.name,'Second');
});

test('over-limit preparation fails without creating a request or modifying the plan', async () => {
  const h = harness(()=>Response.json(metadata()));
  await h.flow.selectWorkspace({id:'workspace-A',name:'Workspace'});
  const plan=fixture(); plan.pages[0].sourceMarkdown='x'.repeat(260000);
  const original=JSON.stringify(plan);
  assert.throws(()=>h.flow.prepare(plan,'Folder'),error=>error.code==='IMPORT_BUNDLE_TOO_LARGE');
  assert.equal(JSON.stringify(plan),original); assert.equal(h.flow.body,null); assert.equal(h.posts().length,0);
});

test('the default browser fetch adapter keeps its required global receiver', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async function () { assert.equal(this, globalThis); return Response.json(metadata()); };
    const flow = new AccountImportFlow({ prepare: prepareNotionImportBundle, build: buildNotionImportBundle });
    flow.setActor(actor); await flow.selectWorkspace({ id: 'workspace-A', name: 'Workspace' });
    assert.equal(flow.workspace.id, 'workspace-A');
  } finally { globalThis.fetch = original; }
});

test('native CSV mappings and conversion mode stay fixed across review and retry', async () => {
  const h=harness((path,options)=>path.endsWith('/get-session')?Response.json({user:actor}):options.method==='POST'?Response.json(success(JSON.parse(options.body)),{status:201}):Response.json(metadata()));
  await h.flow.selectWorkspace({id:'workspace-A',name:'Workspace'});
  const plan=fixture(); plan.matches=[{collectionId:'collection-1',rowId:'row-1',pageId:'page-1',method:'exact-title-in-cell',confirmed:false,ambiguous:false}]; plan.summary.matchingCandidates=1;
  const options={csvMode:'native',rowPageMappings:[{collectionId:'collection-1',rowId:'row-1',pageId:'page-1'}]};
  const prepared=h.flow.prepare(plan,'Native table',options);
  assert.equal(prepared.summary.nativeCollections,1); assert.equal(prepared.summary.mappedRows,1);
  assert.equal(prepared.body.pages.length,3); assert.equal(prepared.body.collections.length,1);
  assert.ok(prepared.requiredAcknowledgements.includes('csvTextTypes'));
  options.csvMode='reference'; options.rowPageMappings.length=0;
  assert.equal(h.flow.options.csvMode,'native'); assert.equal(h.flow.options.rowPageMappings.length,1);
  await assert.rejects(h.flow.submit({acknowledgements:acks,consent:true}),/ACKNOWLEDGEMENT_REQUIRED/);
  await h.flow.submit({acknowledgements:{...acks,csvTextTypes:true},consent:true});
  assert.deepEqual(JSON.parse(h.posts()[0].options.body),prepared.body);
});

test('staged asset references are reviewed and frozen without putting attachment bytes into JSON',async()=> {
 const h=harness((path,options)=>path.endsWith('/get-session')?Response.json({user:actor}):options.method==='POST'?Response.json(success(JSON.parse(options.body)),{status:201}):Response.json({...metadata(),attachmentsEnabled:true}));
 await h.flow.selectWorkspace({id:'workspace-A',name:'Workspace'}); assert.equal(h.flow.workspace.attachmentsEnabled,true);
 const refs=[{sourceId:'entry-3',assetId:'server-asset'}];
 const prepared=h.flow.prepare(fixture(),'With attachments',{csvMode:'native',assets:refs});
 assert.equal(prepared.summary.attachmentsIncluded,1); assert.equal(prepared.summary.attachmentsExcluded,0);
 assert.equal(prepared.requiredAcknowledgements.includes('excludedAssets'),false);
 refs[0].assetId='changed'; assert.equal(prepared.body.assets[0].assetId,'server-asset');
 await h.flow.submit({acknowledgements:{csvTextTypes:true,linksUnconverted:true},consent:true});
 const body=JSON.parse(h.posts()[0].options.body); assert.equal(body.importId,prepared.body.importId);
 assert.deepEqual(body.assets,prepared.body.assets); assert.deepEqual(Object.keys(body.assets[0]).sort(),['assetId','pageSourceIds','sourceId']);
 assert.equal(JSON.stringify(body).includes('Uint8Array'),false);
});


test('AppFlowy source and reviewed payload remain frozen across an uncertain retry',async()=>{
 let attempts=0;
 const h=harness((path,options)=>path.endsWith('/get-session')?Response.json({user:actor}):options.method==='POST'?(++attempts===1?Promise.reject(new Error('synthetic network interruption')):Response.json(success(JSON.parse(options.body)),{status:200})):Response.json(metadata()));
 await h.flow.selectWorkspace({id:'workspace-A',name:'Workspace'});
 const plan=fixture();plan.source='appflowy-markdown-csv';plan.entries.pop();plan.summary.entries=2;plan.summary.attachments=0;plan.summary.uncompressedBytes-=3;
 const prepared=h.flow.prepare(plan,'AppFlowy review',{csvMode:'native'});const body=JSON.stringify(prepared.body);
 assert.match(prepared.body.pages[0].blocks[0].data.text,/^AppFlowy import/);
 plan.source='notion-markdown-csv';plan.pages[0].title='Changed after review';
 await assert.rejects(h.flow.submit({acknowledgements:{csvTextTypes:true,linksUnconverted:true},consent:true}),/NETWORK_UNCERTAIN/);
 assert.equal(JSON.stringify(h.flow.body),body);
 await h.flow.submit({acknowledgements:{csvTextTypes:true,linksUnconverted:true},consent:true});
 assert.equal(h.posts().length,2);assert.equal(h.posts()[0].options.body,h.posts()[1].options.body);
 assert.equal(h.posts()[0].options.headers['X-Yumunio-Expected-Account'],actor.id);
});
