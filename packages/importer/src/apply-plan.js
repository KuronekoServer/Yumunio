import { IMPORT_LIMITS, scanMarkdownLinks, resolveImportLink, classifyImportEntry } from './index.js';
import { prepareAppFlowyNativeBundle, buildAppFlowyNativeBundle } from './appflowy-native.js';
import { renderMarkdownInline } from './markdown.js';

export const IMPORT_BUNDLE_LIMITS = Object.freeze({ pages: 100, requestBytes: 256000, textChars: 100000, assets: 100, assetBindings: 1000 });
const encoder = new TextEncoder();
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const own = (value, key) => Object.hasOwn(value, key);
const nativePlan = value => value && typeof value === 'object' &&
  Object.getOwnPropertyDescriptor(value, 'source')?.value === 'appflowy-native' &&
  Object.getOwnPropertyDescriptor(value, 'schemaVersion')?.value === 2;
const fail = (code, required = []) => { throw new ImportBundleError(code, required); };
export class ImportBundleError extends Error {
  constructor(code, requiredAcknowledgements = []) {
    super('The import bundle could not be prepared.');
    this.name = 'ImportBundleError'; this.code = code;
    this.requiredAcknowledgements = Object.freeze([...requiredAcknowledgements]);
  }
}
function json(value) {
  const ancestors = new Set(); let nodes = 0, chars = 0;
  const visit = (item, depth) => {
    if (++nodes > 200000 || depth > 32) fail('INVALID_IMPORT_PLAN');
    if (typeof item === 'string') { chars += item.length; if (chars > 32 * 1024 * 1024) fail('IMPORT_BUNDLE_TOO_LARGE'); return; }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (typeof item !== 'object' || ancestors.has(item)) fail('INVALID_IMPORT_PLAN');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail('INVALID_IMPORT_PLAN');
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
    if (array && keys.length !== item.length + 1) fail('INVALID_IMPORT_PLAN');
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value') ||
          (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) fail('INVALID_IMPORT_PLAN');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}
function object(value, fields, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key) && !optional.includes(key)) || fields.some(key => !own(value, key))) fail('INVALID_IMPORT_PLAN');
}
function array(value, max) { if (!Array.isArray(value) || value.length > max) fail('INVALID_IMPORT_PLAN'); }
function text(value, max = 2 * 1024 * 1024) { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('INVALID_IMPORT_PLAN'); }
function id(value) { if (!identifier(value)) fail('INVALID_IMPORT_PLAN'); }
function title(value) { text(value, 240); return value; }
function number(value, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_IMPORT_PLAN'); }
function path(value) {
  text(value, IMPORT_LIMITS.pathChars);
  if (!value || value !== value.normalize('NFC') || value.startsWith('/') || /[\\:\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('INVALID_IMPORT_PLAN');
  const parts = value.split('/');
  if (parts.length > IMPORT_LIMITS.depth || parts.some(part => !part || part === '.' || part === '..')) fail('INVALID_IMPORT_PLAN');
}
const stem = value => value.replace(/\.[^/.]+$/, '');
const parentPath = value => { const slash = value.lastIndexOf('/'); return slash < 0 ? null : value.slice(0, slash); };

/** Validate the full untrusted JSON preview, including cross-references, without invoking getters. */
function validatePlan(plan) {
  json(plan);
  object(plan, ['schemaVersion','source','summary','warnings','entries','pages','collections','links','matches','unsupported']);
  if (plan.schemaVersion !== 1 || !['notion-markdown-csv','appflowy-markdown-csv'].includes(plan.source)) fail('INVALID_IMPORT_PLAN');
  array(plan.entries, IMPORT_LIMITS.entries); array(plan.pages, IMPORT_LIMITS.entries); array(plan.collections, IMPORT_LIMITS.entries);
  array(plan.links, IMPORT_LIMITS.links); array(plan.matches, IMPORT_LIMITS.matches); array(plan.unsupported, IMPORT_LIMITS.entries);
  array(plan.warnings, 100);
  for (const warning of plan.warnings) { object(warning,['code','message','count']); text(warning.code,128); text(warning.message,2000); number(warning.count,100000); }
  const entries = new Map(), paths = new Set();
  const referencedAssets = new Set(plan.links.filter(link => link?.kind === 'attachment').map(link => link.targetId));
  for (const entry of plan.entries) {
    object(entry,['id','path','kind','bytes'],['modelId']);
    id(entry.id); path(entry.path); number(entry.bytes,IMPORT_LIMITS.entryBytes);
    const extension=/\.([^.\/]+)$/.exec(entry.path)?.[1].toLowerCase()??'';
    const baseKind=classifyImportEntry(entry.path,plan.source);
    const expectedKind=plan.source==='appflowy-markdown-csv' && baseKind==='attachment' && !referencedAssets.has(entry.id)?'unsupported':baseKind;
    if (entry.kind!==expectedKind) fail('INVALID_IMPORT_PLAN');
    if (!['page','collection','attachment','unsupported'].includes(entry.kind) || entries.has(entry.id) || paths.has(entry.path.toLowerCase())) fail('INVALID_IMPORT_PLAN');
    if (['page','collection'].includes(entry.kind) ? !identifier(entry.modelId) : own(entry,'modelId')) fail('INVALID_IMPORT_PLAN');
    entries.set(entry.id,entry); paths.add(entry.path.toLowerCase());
  }
  const pageIds = new Set(), modelIds = new Set(), usedEntries = new Set(), pageStems = new Map();
  let blockCount = 0;
  for (const page of plan.pages) {
    object(page,['id','entryId','title','sourceMarkdown','blocks','propertyCandidates','parentCandidateId']);
    id(page.id); id(page.entryId); title(page.title); text(page.sourceMarkdown);
    if (encoder.encode(page.sourceMarkdown).length > IMPORT_LIMITS.textBytes) fail('INVALID_IMPORT_PLAN');
    if (page.parentCandidateId !== null) id(page.parentCandidateId);
    const entry = entries.get(page.entryId);
    if (!entry || entry.kind !== 'page' || entry.modelId !== page.id || modelIds.has(page.id) || usedEntries.has(page.entryId)) fail('INVALID_IMPORT_PLAN');
    pageIds.add(page.id); modelIds.add(page.id); usedEntries.add(page.entryId);
    pageStems.set(stem(entry.path),page.id);
    array(page.blocks,IMPORT_LIMITS.blocks); blockCount += page.blocks.length;
    if (blockCount > IMPORT_LIMITS.blocks) fail('INVALID_IMPORT_PLAN');
    const blockIds = new Set(), blockDepths = new Map(), childParents = new Set();
    for (const block of page.blocks) {
      object(block,['id','kind','text'],['level','checked','parentBlockId','listStyle','start','language']);
      id(block.id); text(block.text);
      if (blockIds.has(block.id) || !['heading','paragraph','todo','list-item','quote','code','divider'].includes(block.kind)) fail('INVALID_IMPORT_PLAN');
      if (block.kind === 'heading' ? !Number.isInteger(block.level) || block.level < 1 || block.level > 6 || own(block,'checked') :
          block.kind === 'todo' ? typeof block.checked !== 'boolean' || own(block,'level') : own(block,'level') || own(block,'checked')) fail('INVALID_IMPORT_PLAN');
      if (own(block,'parentBlockId')) {
        id(block.parentBlockId);
        if (!blockIds.has(block.parentBlockId) || !childParents.has(block.parentBlockId) || (blockDepths.get(block.parentBlockId) ?? 0) >= 8) fail('INVALID_IMPORT_PLAN');
      }
      blockDepths.set(block.id, own(block,'parentBlockId') ? blockDepths.get(block.parentBlockId) + 1 : 0);
      if (!['code','divider'].includes(block.kind)) childParents.add(block.id);
      if (own(block,'listStyle') && (block.kind !== 'list-item' || !['bulleted','numbered'].includes(block.listStyle))) fail('INVALID_IMPORT_PLAN');
      if (own(block,'start') && (block.kind !== 'list-item' || block.listStyle !== 'numbered' || !Number.isSafeInteger(block.start) || block.start < 0 || block.start > 999999999)) fail('INVALID_IMPORT_PLAN');
      if (own(block,'language') && (block.kind !== 'code' || typeof block.language !== 'string' || !/^[A-Za-z0-9_+.#-]{1,100}$/.test(block.language))) fail('INVALID_IMPORT_PLAN');
      if (block.kind === 'divider' && block.text !== '') fail('INVALID_IMPORT_PLAN');
      blockIds.add(block.id);
    }
    array(page.propertyCandidates,IMPORT_LIMITS.blocks);
    for (const property of page.propertyCandidates) {
      object(property,['name','value','confirmed']); text(property.name,101); text(property.value);
      if (property.confirmed !== false) fail('INVALID_IMPORT_PLAN');
    }
  }
  for (const page of plan.pages) {
    const expected = pageStems.get(parentPath(entries.get(page.entryId).path)) ?? null;
    if (page.parentCandidateId !== expected || (page.parentCandidateId !== null && !pageIds.has(page.parentCandidateId))) fail('INVALID_IMPORT_PLAN');
  }
  let records = 0, columns = 0;
  const collectionIds = new Set(), rowIds = new Map();
  for (const collection of plan.collections) {
    object(collection,['id','entryId','title','columns','rows']);
    id(collection.id); id(collection.entryId); title(collection.title);
    const entry = entries.get(collection.entryId);
    if (!entry || entry.kind !== 'collection' || entry.modelId !== collection.id || modelIds.has(collection.id) || usedEntries.has(collection.entryId)) fail('INVALID_IMPORT_PLAN');
    modelIds.add(collection.id); collectionIds.add(collection.id); usedEntries.add(collection.entryId);
    array(collection.columns,IMPORT_LIMITS.csvColumns); array(collection.rows,IMPORT_LIMITS.csvRows);
    if (!collection.columns.length) fail('INVALID_IMPORT_PLAN');
    records += collection.rows.length; columns += collection.columns.length;
    if (records > IMPORT_LIMITS.csvRows || columns > IMPORT_LIMITS.columns) fail('INVALID_IMPORT_PLAN');
    const columnIds = new Set(), rows = new Set();
    for (const column of collection.columns) {
      object(column,['id','name','type','confirmed']); id(column.id); text(column.name,IMPORT_LIMITS.cellChars);
      if (columnIds.has(column.id) || column.type !== 'text' || column.confirmed !== false) fail('INVALID_IMPORT_PLAN');
      columnIds.add(column.id);
    }
    for (const row of collection.rows) {
      object(row,['id','cells']); id(row.id); array(row.cells,IMPORT_LIMITS.csvColumns);
      if (rows.has(row.id) || row.cells.length !== collection.columns.length) fail('INVALID_IMPORT_PLAN');
      rows.add(row.id);
      for (const cell of row.cells) text(cell,IMPORT_LIMITS.cellChars);
    }
    rowIds.set(collection.id,rows);
  }
  if (plan.entries.some(entry => ['page','collection'].includes(entry.kind) && !usedEntries.has(entry.id))) fail('INVALID_IMPORT_PLAN');
  const linkIds = new Set();
  const pagesById=new Map(plan.pages.map(page=>[page.id,page]));
  const blocksByPage=new Map(plan.pages.map(page=>[page.id,new Map(page.blocks.map(block=>[block.id,block]))]));
  const entriesByPath=new Map(plan.entries.map(entry=>[entry.path,entry])),scannedLinks=new Map(),locatedSpans=new Set();
  const attachmentIds = new Set(plan.entries.filter(entry=>entry.kind==='attachment').map(entry=>entry.id));
  const unsupportedEntryIds = new Set(plan.entries.filter(entry=>entry.kind==='unsupported').map(entry=>entry.id));
  for (const link of plan.links) {
    object(link,['id','sourceId','label','image','kind'],['href','targetId','reason','fragment','blockId','start','end','labelStart','labelEnd','hrefStart','hrefEnd','rawHref']);
    id(link.id); id(link.sourceId); text(link.label); if (typeof link.image !== 'boolean' || !pageIds.has(link.sourceId) || linkIds.has(link.id)) fail('INVALID_IMPORT_PLAN');
    linkIds.add(link.id);
    const spanFields=['blockId','start','end','labelStart','labelEnd','hrefStart','hrefEnd','rawHref'];
    if (spanFields.some(field=>own(link,field))) {
      if (!spanFields.every(field=>own(link,field))) fail('INVALID_IMPORT_PLAN');
      id(link.blockId); text(link.rawHref);
      for (const field of spanFields.filter(field=>!['blockId','rawHref'].includes(field))) number(link[field],IMPORT_LIMITS.textBytes);
      const page=pagesById.get(link.sourceId), block=blocksByPage.get(link.sourceId).get(link.blockId);
      if (!block || block.kind==='code') fail('INVALID_IMPORT_PLAN');
      const blockKey=link.sourceId+'\0'+link.blockId,spanKey=link.start+':'+link.end,locationKey=blockKey+'\0'+spanKey;
      if(locatedSpans.has(locationKey))fail('INVALID_IMPORT_PLAN');
      locatedSpans.add(locationKey);
      if(!scannedLinks.has(blockKey))scannedLinks.set(blockKey,new Map(scanMarkdownLinks(block.text).map(candidate=>[candidate.start+':'+candidate.end,candidate])));
      const exact=scannedLinks.get(blockKey).get(spanKey);
      if (!exact || ['label','image','labelStart','labelEnd','hrefStart','hrefEnd'].some(field=>exact[field]!==link[field]) || exact.href!==link.rawHref) fail('INVALID_IMPORT_PLAN');
      const entry=entries.get(page.entryId);
      const expected=resolveImportLink(exact.href,entry.path,entriesByPath);
      if (['kind','targetId','href','reason','fragment'].some(field=>expected[field]!==link[field])) fail('INVALID_IMPORT_PLAN');
    }
    if (own(link,'fragment')) {
      text(link.fragment,512); if (/[\u0000-\u001f\u007f]/.test(link.fragment)) fail('INVALID_IMPORT_PLAN');
    }

    if (['page','collection','attachment','unsupported'].includes(link.kind)) {
      if (own(link,'href') || own(link,'reason') || !identifier(link.targetId) ||
          !(link.kind === 'page' ? pageIds : link.kind === 'collection' ? collectionIds : link.kind === 'attachment' ? attachmentIds : unsupportedEntryIds).has(link.targetId)) fail('INVALID_IMPORT_PLAN');
    } else if (['external','fragment'].includes(link.kind)) {
      if (own(link,'targetId') || own(link,'reason')) fail('INVALID_IMPORT_PLAN'); text(link.href);
      if (link.kind === 'fragment' ? !link.href.startsWith('#') : !/^(?:https?|mailto|tel):/i.test(link.href)) fail('INVALID_IMPORT_PLAN');
    } else if (['blocked','unresolved'].includes(link.kind)) {
      if (own(link,'targetId') || own(link,'href')) fail('INVALID_IMPORT_PLAN'); text(link.reason,128);
    } else fail('INVALID_IMPORT_PLAN');
  }
  for (const match of plan.matches) {
    object(match,['collectionId','rowId','pageId','method','confirmed','ambiguous']);
    if (!collectionIds.has(match.collectionId) || !rowIds.get(match.collectionId).has(match.rowId) || !pageIds.has(match.pageId) ||
        match.method !== 'exact-title-in-cell' || match.confirmed !== false || typeof match.ambiguous !== 'boolean') fail('INVALID_IMPORT_PLAN');
  }
  const unsupportedIds = new Set();
  for (const unsupported of plan.unsupported) {
    object(unsupported,['entryId','reason']); text(unsupported.reason,128);
    if (unsupportedIds.has(unsupported.entryId) || entries.get(unsupported.entryId)?.kind !== 'unsupported') fail('INVALID_IMPORT_PLAN');
    unsupportedIds.add(unsupported.entryId);
  }
  if (unsupportedIds.size !== plan.entries.filter(entry=>entry.kind==='unsupported').length) fail('INVALID_IMPORT_PLAN');
  const actual = { entries:plan.entries.length,pages:plan.pages.length,collections:plan.collections.length,records,
    attachments:attachmentIds.size,links:plan.links.length,unresolvedLinks:plan.links.filter(link=>link.kind==='unresolved').length,
    matchingCandidates:plan.matches.length,unsupported:unsupportedIds.size };
  object(plan.summary,[...Object.keys(actual),'archiveBytes','uncompressedBytes']);
  for (const [key,value] of Object.entries(actual)) if (plan.summary[key] !== value) fail('INVALID_IMPORT_PLAN');
  number(plan.summary.archiveBytes,IMPORT_LIMITS.archiveBytes); number(plan.summary.uncompressedBytes,IMPORT_LIMITS.totalBytes);
  if (plan.summary.uncompressedBytes !== plan.entries.reduce((sum,entry)=>sum+entry.bytes,0)) fail('INVALID_IMPORT_PLAN');
  return { entries, actual };
}
function optionsOf(options, allowAcknowledgements, defaultRootTitle = 'Notionからの取込み') {
  json(options);
  object(options,['expectedRevision','importId'],['rootTitle','csvMode','rowPageMappings','assets',...(allowAcknowledgements?['acknowledgements']:[])]);
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0 || options.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !identifier(options.importId)) fail('INVALID_IMPORT_OPTIONS');
  const rootTitle = options.rootTitle ?? defaultRootTitle, csvMode=options.csvMode??'native';
  if (typeof rootTitle !== 'string' || !rootTitle.trim() || rootTitle.length > 240 || rootTitle.includes('\0') ||
      !['native','reference'].includes(csvMode)) fail('INVALID_IMPORT_OPTIONS');
  const acknowledgements = options.acknowledgements ?? {};
  object(acknowledgements,[],['csvReference','csvTextTypes','linksUnconverted','excludedAssets']);
  if (Object.values(acknowledgements).some(value=>typeof value !== 'boolean')) fail('INVALID_IMPORT_OPTIONS');
  const rowPageMappings=options.rowPageMappings??[];
  array(rowPageMappings,100);
  const rows=new Set(), pages=new Set();
  for (const mapping of rowPageMappings) {
    object(mapping,['collectionId','rowId','pageId']);
    for (const field of ['collectionId','rowId','pageId']) id(mapping[field]);
    const key=mapping.collectionId+'\0'+mapping.rowId;
    if (rows.has(key)||pages.has(mapping.pageId)||csvMode!=='native') fail('INVALID_ROW_MAPPING');
    rows.add(key);pages.add(mapping.pageId);
  }
  const assets=options.assets??[];
  array(assets,IMPORT_BUNDLE_LIMITS.assets);
  const assetSources=new Set(),assetIds=new Set();
  for(const asset of assets) {
    object(asset,['sourceId','assetId']);id(asset.sourceId);id(asset.assetId);
    if(assetSources.has(asset.sourceId)||assetIds.has(asset.assetId))fail('INVALID_IMPORT_OPTIONS');
    assetSources.add(asset.sourceId);assetIds.add(asset.assetId);
  }
  return {expectedRevision:options.expectedRevision,importId:options.importId,rootTitle,csvMode,rowPageMappings,assets,acknowledgements};
}
function blockWriter() {
  const blocks=[], all=[];
  return {blocks,append(type,value,data={},parent=null) {
    const {links=[],marks=[],...baseData}=data, created=[];
    let offset=0;
    do {
      let end=Math.min(value.length,offset+IMPORT_BUNDLE_LIMITS.textChars);
      const inRange=links.filter(link=>link.start>=offset&&link.start<end);
      if(inRange.length>1000)end=inRange[1000].start;
      const markRange=marks.filter(mark=>mark.end>offset&&mark.start<end);
      if(markRange.length>1000)end=Math.min(end,markRange[1000].start);
      const crossing=links.find(link=>link.start<end&&link.end>end);
      if(crossing) {
        if(crossing.start>offset)end=crossing.start;
        else if(crossing.end-offset<=IMPORT_BUNDLE_LIMITS.textChars&&marks.filter(mark=>mark.end>offset&&mark.start<crossing.end).length<=1000)end=crossing.end;
      }
      if(end<value.length&&/[\ud800-\udbff]/.test(value[end-1])&&/[\udc00-\udfff]/.test(value[end]))end--;
      const localLinks=links.filter(link=>link.end>offset&&link.start<end).map(link=>{
        const start=Math.max(link.start,offset),finish=Math.min(link.end,end);
        return {...link,start:start-offset,end:finish-offset,label:value.slice(start,finish)};
      });
      const localMarks=marks.filter(mark=>mark.end>offset&&mark.start<end).map(mark=>({...mark,start:Math.max(mark.start,offset)-offset,end:Math.min(mark.end,end)-offset}));
      if(end===offset&&offset<value.length)fail('IMPORT_BUNDLE_TOO_LARGE');
      const block={id:'import-block-'+(all.length+1),type,data:{text:value.slice(offset,end),...baseData,...(localLinks.length?{links:localLinks}:{}),...(localMarks.length?{marks:localMarks}:{})}};
      all.push(block); created.push(block);
      if(parent)(parent.children??=[]).push(block); else blocks.push(block);
      offset=end;
    } while(offset<value.length);
    if(type==='code'&&data.purpose==='import-source') {
      const count=all.filter(block=>block.type==='code'&&block.data.purpose===data.purpose&&block.data.language===data.language).length;
      if(count>1) {
        let part=0;
        for(const block of all.filter(block=>block.type==='code'&&block.data.purpose===data.purpose&&block.data.language===data.language)) {
          block.data.sourcePart=++part;block.data.sourceParts=count;
        }
      }
    }
    return created;
  }};
}
function sourceLinks(block,pageId,locatedLinks,settings,sources,collectionSources,assetSources,assetReferences,entries) {
  const candidates=locatedLinks.get(pageId+'\0'+block.id)??[];
  const converted=[];
  let text='',cursor=0;
  for(const link of candidates) {
    let target;
    if(link.kind==='page')target={sourcePageId:sources.get(link.targetId)};
    else if(link.kind==='collection')target=settings.csvMode==='native'?{sourceCollectionId:collectionSources.get(link.targetId)}:{sourcePageId:sources.get(link.targetId)};
    else if(link.kind==='fragment'&&own(link,'fragment'))target={sourcePageId:sources.get(pageId)};
    else if(link.kind==='attachment'&&assetSources.has(link.targetId))target={sourceAssetId:link.targetId};
    const label=link.label||(target?.sourceAssetId?entries.get(link.targetId).path.split('/').at(-1):'');
    if(!target||Object.values(target).some(value=>!value)||(link.image&&!target.sourceAssetId)||!label||label.length>IMPORT_BUNDLE_LIMITS.textChars||
       (link.rawHref.includes('#')&&!own(link,'fragment'))||link.rawHref.includes('?'))continue;
    if(link.start<cursor)fail('INVALID_IMPORT_PLAN');
    text+=block.text.slice(cursor,link.start);
    const start=text.length;
    text+=label;
    if(target.sourceAssetId)assetReferences.get(target.sourceAssetId).add(sources.get(pageId));
    converted.push({start,end:text.length,label,...target,...(own(link,'fragment')?{fragment:link.fragment}:{})});
    cursor=link.end;
  }
  return {text:text+block.text.slice(cursor),links:converted};
}
const messages = Object.freeze({
  SOURCE_PRESERVED:'元MarkdownとCSVの文字列を、読取り専用の参照ブロックにも保持します。',
  MARKDOWN_SUBSET:"見出し（1〜3段階）・段落・入れ子のリスト・引用・コードと基本の文字装飾を変換します。未対応の書式は原文に保持し、完全な書式の再現は行いません。",
  CSV_REFERENCE_ONLY:'CSVは文字列の参照ページとして保存します。DB、型、数式やrelationへは変換しません。',
  CSV_TEXT_TYPES:'CSVは全列をtextとして取り込み、空欄も文字列で保持します。型・数式・relationを推測しません。',
  COLUMN_NAMES_NORMALIZED:'空または長い列名には表示名を付け、元の列名を別に保持します。',
  INTERNAL_LINKS_CONVERTED:'位置と対象を確認した内部リンクを、新しいページ・コレクションへの参照に変換します。',
  LINKS_UNCONVERTED:'位置や対象が未確定のリンク、外部リンク、未保存添付のリンクは元の文字列で保持します。',
  ASSETS_INCLUDED:'保存済み添付を参照ページの権限に従うファイルとして取り込みます。',
  ASSETS_EXCLUDED:'未保存の添付や未対応形式があります。元のZIPを別途保持してください。',
  MATCHES_NOT_MERGED:'同題だけではCSV行とMarkdownを結合しません。明示指定のない行は新しいページになります。',
  ROW_MAPPINGS_APPLIED:'明示指定したMarkdownページだけをCSV行へ結び付けます。',
  PERMISSIONS_NOT_IMPORTED:'元の共有権限・コメント・履歴は取込みません。新しい私有ルート配下への作成です。',
});

/** Preparation is pure and private: it does not authorize or apply the returned request body. */
export function prepareImportBundle(plan, options) {
  if (nativePlan(plan)) return prepareAppFlowyNativeBundle(plan, options);
  const {entries,actual}=validatePlan(plan),settings=optionsOf(options,false,plan.source==='appflowy-markdown-csv'?'AppFlowyからの取込み':'Notionからの取込み');
  const sourceLabel=plan.source==='appflowy-markdown-csv'?'AppFlowy':'Notion', sourceFormat=plan.source==='appflowy-markdown-csv'?'appflowy':'notion';
  if(!actual.pages&&!actual.collections)fail('NO_IMPORTABLE_CONTENT');
  const sources=new Map(),sourceStems=new Map(),collectionSources=new Map(),mappedRows=new Map(),mappedParents=new Map();
  const locatedLinks=new Map();
  for(const link of plan.links.filter(link=>own(link,'start'))) {
    const key=link.sourceId+'\0'+link.blockId;
    if(!locatedLinks.has(key))locatedLinks.set(key,[]);
    locatedLinks.get(key).push(link);
  }
  for(const links of locatedLinks.values())links.sort((a,b)=>a.start-b.start);
  const assetSources=new Set(),assetReferences=new Map();
  for(const asset of settings.assets) {
    if(entries.get(asset.sourceId)?.kind!=='attachment')fail('INVALID_IMPORT_OPTIONS');
    assetSources.add(asset.sourceId);assetReferences.set(asset.sourceId,new Set());
  }
  const attachmentsExcluded=actual.attachments-settings.assets.length;
  plan.pages.forEach((page,index)=>{sources.set(page.id,'markdown-'+(index+1));sourceStems.set(stem(entries.get(page.entryId).path),'markdown-'+(index+1));});
  plan.collections.forEach((collection,index)=>{
    const sourceId='csv-'+(index+1),sourceStem=stem(entries.get(collection.entryId).path);
    sources.set(collection.id,sourceId);collectionSources.set(collection.id,'native-collection-'+(index+1));
    if(!sourceStems.has(sourceStem))sourceStems.set(sourceStem,sourceId);
  });
  for(const mapping of settings.rowPageMappings) {
    const collection=plan.collections.find(collection=>collection.id===mapping.collectionId);
    if(!collection?.rows.some(row=>row.id===mapping.rowId)||!plan.pages.some(page=>page.id===mapping.pageId))fail('INVALID_ROW_MAPPING');
    mappedRows.set(mapping.collectionId+'\0'+mapping.rowId,mapping.pageId);
    mappedParents.set(mapping.pageId,sources.get(mapping.collectionId));
  }
  const newRows=settings.csvMode==='native'?actual.records-mappedRows.size:0;
  if(actual.pages+actual.collections+newRows+1>IMPORT_BUNDLE_LIMITS.pages)fail('TOO_MANY_IMPORT_PAGES');
  const parent=entryId=>sourceStems.get(parentPath(entries.get(entryId).path))??'import-root';
  const root=blockWriter(),pages=[],collections=[];
  root.append('paragraph',sourceLabel+' import · Markdown '+actual.pages+' / CSV '+actual.collections+' / records '+actual.records+'.');
  root.append('paragraph','CSV: '+settings.csvMode+'. Attachments included: '+settings.assets.length+'. Attachments excluded: '+attachmentsExcluded+'. Unsupported excluded: '+actual.unsupported+'.');
  pages.push({sourceId:'import-root',parentSourceId:null,title:settings.rootTitle,blocks:root.blocks});
  let convertedLinks=0,normalizedColumns=0;
  for(const page of plan.pages) {
    const output=blockWriter(), parents=new Map();
    for(const block of page.blocks) {
      const converted=sourceLinks(block,page.id,locatedLinks,settings,sources,collectionSources,assetSources,assetReferences,entries);
      convertedLinks+=converted.links.length;
      const inline=['code','divider'].includes(block.kind)?{text:converted.text,marks:[],offsets:null}:
        renderMarkdownInline(converted.text,{literalRanges:scanMarkdownLinks(converted.text)});
      const links=converted.links.map(link=>{
        const start=inline.offsets?.[link.start]??link.start,end=inline.offsets?.[link.end]??link.end;
        return {...link,start,end,label:inline.text.slice(start,end)};
      });
      const data={...(links.length?{links}:{}),...(inline.marks.length?{marks:inline.marks}:{})};
      const parent=own(block,'parentBlockId')?parents.get(block.parentBlockId):null;
      let type='paragraph';
      if(block.kind==='heading'){type='heading';data.level=Math.min(3,block.level);}
      else if(block.kind==='todo'){type='checklist';data.checked=block.checked;}
      else if(block.kind==='list-item'){type=block.listStyle==='numbered'?'numbered-list':'bulleted-list';if(type==='numbered-list')data.start=Math.max(1,block.start??1);}
      else if(block.kind==='quote')type='quote';
      else if(block.kind==='code'){type='code';if(block.language)data.language=block.language;}
      else if(block.kind==='divider')type='divider';
      parents.set(block.id,output.append(type,inline.text,data,parent).at(-1));
    }
    output.append('code',page.sourceMarkdown,{language:'markdown',purpose:'import-source'});
    pages.push({sourceId:sources.get(page.id),parentSourceId:mappedParents.get(page.id)??(page.parentCandidateId===null?parent(page.entryId):sources.get(page.parentCandidateId)),title:page.title,blocks:output.blocks});
  }
  plan.collections.forEach((collection,collectionIndex)=>{
    const output=blockWriter(),native=settings.csvMode==='native';
    output.append('paragraph',native?'CSV collection · all imported values are text.':'CSV reference · values are text; not a native database.');
    output.append('paragraph',collection.columns.map((column,index)=>(index+1)+'. '+column.name).join('\n'));
    if(!native)collection.rows.forEach((row,index)=>output.append('paragraph','Row '+(index+1)+'\n'+row.cells.map((cell,column)=>
      (column+1)+'. '+collection.columns[column].name+': '+JSON.stringify(cell)).join('\n')));
    output.append('code',JSON.stringify(native?{format:sourceFormat+'-csv-headers-v1',columns:collection.columns.map(column=>column.name)}:
      {format:sourceFormat+'-csv-reference-v1',columns:collection.columns.map(column=>column.name),rows:collection.rows.map(row=>[...row.cells])}),{language:'json',purpose:'import-source'});
    pages.push({sourceId:sources.get(collection.id),parentSourceId:parent(collection.entryId),title:collection.title,blocks:output.blocks});
    if(native) {
      const properties=collection.columns.map((column,index)=>{
        const valid=column.name.trim()&&column.name.length<=128;
        if(!valid)normalizedColumns++;
        return {id:column.id,name:valid?column.name:'Column '+(index+1),type:'text',sourceName:column.name};
      });
      const records=collection.rows.map((row,rowIndex)=>{
        const mapping=mappedRows.get(collection.id+'\0'+row.id),sourceId='csv-row-'+(collectionIndex+1)+'-'+(rowIndex+1);
        const pageSourceId=mapping?sources.get(mapping):sourceId;
        if(!mapping)pages.push({sourceId,parentSourceId:sources.get(collection.id),
          title:row.cells[0]?.trim()&&row.cells[0].length<=240?row.cells[0]:'Row '+(rowIndex+1),blocks:[]});
        const rowPage=pages.find(page=>page.sourceId===pageSourceId),rowSource=blockWriter();
        rowSource.append('code',JSON.stringify({format:sourceFormat+'-csv-row-v1',columns:collection.columns.map(column=>column.name),cells:[...row.cells]}),
          {language:'json',purpose:'import-source'});
        const countBlocks=blocks=>blocks.reduce((count,block)=>count+1+countBlocks(block.children??[]),0);
        const existingBlocks=countBlocks(rowPage.blocks);
        rowPage.blocks.push(...rowSource.blocks.map((block,index)=>({...block,id:'import-block-'+(existingBlocks+index+1)})));
        return {sourceId:'record-'+(collectionIndex+1)+'-'+(rowIndex+1),pageSourceId,values:Object.fromEntries(collection.columns.map((column,index)=>[column.id,row.cells[index]]))};
      });
      collections.push({sourceId:collectionSources.get(collection.id),pageSourceId:sources.get(collection.id),properties,records});
    }
  });
  const byId=new Map(pages.map(page=>[page.sourceId,page]));
  if(byId.size!==pages.length)fail('INVALID_ROW_MAPPING');
  for(const page of pages) {
    const seen=new Set();let cursor=page;
    while(cursor.parentSourceId!==null) {
      if(seen.has(cursor.sourceId)||!byId.has(cursor.parentSourceId))fail('INVALID_ROW_MAPPING');
      seen.add(cursor.sourceId);cursor=byId.get(cursor.parentSourceId);
    }
    if(cursor.sourceId!=='import-root')fail('INVALID_ROW_MAPPING');
  }
  const warnings=[],requiredAcknowledgements=[],warn=(code,count=1)=>warnings.push({code,message:messages[code],count});
  warn('SOURCE_PRESERVED',actual.pages+actual.collections);warn('PERMISSIONS_NOT_IMPORTED');
  if(actual.pages)warn('MARKDOWN_SUBSET',actual.pages);
  if(actual.collections) {
    const native=settings.csvMode==='native';
    requiredAcknowledgements.push(native?'csvTextTypes':'csvReference');
    warn(native?'CSV_TEXT_TYPES':'CSV_REFERENCE_ONLY',actual.collections);
  }
  if(normalizedColumns)warn('COLUMN_NAMES_NORMALIZED',normalizedColumns);
  if(convertedLinks)warn('INTERNAL_LINKS_CONVERTED',convertedLinks);
  const unconvertedLinks=actual.links-convertedLinks;
  if(unconvertedLinks){requiredAcknowledgements.push('linksUnconverted');warn('LINKS_UNCONVERTED',unconvertedLinks);}
  if(settings.assets.length)warn('ASSETS_INCLUDED',settings.assets.length);
  if(attachmentsExcluded+actual.unsupported){requiredAcknowledgements.push('excludedAssets');warn('ASSETS_EXCLUDED',attachmentsExcluded+actual.unsupported);}
  if(actual.matchingCandidates>mappedRows.size)warn('MATCHES_NOT_MERGED',actual.matchingCandidates-mappedRows.size);
  if(mappedRows.size)warn('ROW_MAPPINGS_APPLIED',mappedRows.size);
  const assets=settings.assets.map(asset=>({...asset,pageSourceIds:assetReferences.get(asset.sourceId).size?[...assetReferences.get(asset.sourceId)]:['import-root']}));
  if(assets.reduce((sum,asset)=>sum+asset.pageSourceIds.length,0)>IMPORT_BUNDLE_LIMITS.assetBindings)fail('TOO_MANY_ASSET_BINDINGS');
  const body={expectedRevision:settings.expectedRevision,importId:settings.importId,pages,...(collections.length?{collections}:{}),...(assets.length?{assets}:{})};
  const bodyBytes=encoder.encode(JSON.stringify(body)).length;
  if(bodyBytes>IMPORT_BUNDLE_LIMITS.requestBytes)fail('IMPORT_BUNDLE_TOO_LARGE');
  return {body,summary:{pages:pages.length,markdownPages:actual.pages,csvReferencePages:settings.csvMode==='reference'?actual.collections:0,
    nativeCollections:collections.length,recordPages:settings.csvMode==='native'?actual.records:0,mappedRows:mappedRows.size,convertedLinks,
    records:actual.records,attachmentsIncluded:settings.assets.length,attachmentsExcluded,unsupportedExcluded:actual.unsupported,unconvertedLinks,bodyBytes},warnings,requiredAcknowledgements};
}
export function buildImportBundle(plan,options) {
  if (nativePlan(plan)) return buildAppFlowyNativeBundle(plan, options);
  validatePlan(plan);
  const settings=optionsOf(options,true,plan.source==='appflowy-markdown-csv'?'AppFlowyからの取込み':'Notionからの取込み');
  const prepared=prepareImportBundle(plan,{expectedRevision:settings.expectedRevision,importId:settings.importId,rootTitle:settings.rootTitle,
    csvMode:settings.csvMode,rowPageMappings:settings.rowPageMappings,assets:settings.assets});
  const missing=prepared.requiredAcknowledgements.filter(key=>settings.acknowledgements[key]!==true);
  if(missing.length)fail('ACKNOWLEDGEMENT_REQUIRED',missing);
  return prepared;
}

export const prepareNotionImportBundle = prepareImportBundle;
export const buildNotionImportBundle = buildImportBundle;
