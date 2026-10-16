import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdownBlocks,renderMarkdownInline} from '../src/markdown.js';
import {previewNotionImport,scanMarkdownLinks} from '../src/index.js';
import {prepareNotionImportBundle} from '../src/apply-plan.js';
import {validateBlocks} from '../../domain/src/index.js';
import {validateInlineMarks} from '../../domain/src/inline.js';
import {appFlowyNativeZip} from './fixtures/appflowy-native.js';
const enc=new TextEncoder();
const zip=files=>appFlowyNativeZip(new Map(Object.entries(files).map(([path,text])=>[path,enc.encode(text)])));
const parse=source=>parseMarkdownBlocks(source,'page-1',20000);
const prepare=async source=>{const plan=await previewNotionImport(zip({'Page.md':source,'Other.md':'# Other'}));return{plan,result:prepareNotionImportBundle(plan,{expectedRevision:0,importId:'markdown-fidelity'})};};
const flatten=blocks=>blocks.flatMap(block=>[block,...flatten(block.children??[])]);
const sourceOf=page=>page.blocks.filter(b=>b.data.purpose==='import-source'&&b.data.language==='markdown').map(b=>b.data.text).join('');
const marksOf=result=>result.marks.map(m=>({text:result.text.slice(m.start,m.end),styles:m.styles}));

test('block parser preserves heading levels, ordered starts, nested list/checklist structure and language',()=>{
 const source='# **Title**\n\n### Third\n\n7. First\n   - Nested\n     - [x] Done\n\n> Quote\n> > Inner\n\n---\n\n\u0060\u0060\u0060javascript\nconst literal = "**not bold**";\n\u0060\u0060\u0060';
 const parsed=parse(source),blocks=parsed.blocks;
 assert.equal(parsed.title,'Title');assert.deepEqual(blocks.filter(b=>b.kind==='heading').map(b=>b.level),[1,3]);
 const first=blocks.find(b=>b.listStyle==='numbered'),nested=blocks.find(b=>b.listStyle==='bulleted'),todo=blocks.find(b=>b.kind==='todo');
 assert.equal(first.start,7);assert.equal(nested.parentBlockId,first.id);assert.equal(todo.parentBlockId,nested.id);assert.equal(todo.checked,true);
 const quotes=blocks.filter(b=>b.kind==='quote');assert.equal(quotes[1].parentBlockId,quotes[0].id);assert.equal(quotes[0].text,'Quote');
 assert.equal(blocks.at(-1).language,'javascript');assert.equal(blocks.at(-1).text,'const literal = "**not bold**";');assert.ok(blocks.some(b=>b.kind==='divider'));
});

test('real synthetic ZIP to Domain bundle keeps editable nested types, rich text and exact readonly original Markdown',async()=>{
 const source='# **Title**\n\n### Third\n\n- **Parent**\n  3. _Child_\n     - [ ] ~~Task~~\n\n> Quoted \u0060code\u0060\n\n\u0060\u0060\u0060js\n[Literal](Other.md)\n\u0060\u0060\u0060\n\n---';
 const {plan,result}=await prepare(source),page=result.body.pages[1],blocks=flatten(page.blocks);
 assert.equal(plan.pages[0].sourceMarkdown,source);assert.equal(sourceOf(page),source);
 assert.equal(page.blocks[0].type,'heading');assert.equal(page.blocks[0].data.text,'Title');assert.equal(page.blocks[0].data.level,1);
 assert.equal(page.blocks[1].data.level,3);assert.equal(page.blocks[2].type,'bulleted-list');
 const child=page.blocks[2].children[0];assert.equal(child.type,'numbered-list');assert.equal(child.data.start,3);assert.equal(child.children[0].type,'checklist');
 assert.equal(child.children[0].data.text,'Task');assert.deepEqual(child.children[0].data.marks[0].styles,['strike']);
 assert.ok(blocks.some(b=>b.type==='quote'&&b.data.text==='Quoted code'));assert.ok(blocks.some(b=>b.type==='code'&&b.data.language==='js'&&b.data.text==='[Literal](Other.md)'));
 assert.equal(plan.links.length,0);assert.doesNotThrow(()=>validateBlocks(page.blocks));
});

test('inline nested emphasis produces disjoint canonical UTF16 runs for CJK and emoji',()=>{
 const result=renderMarkdownInline('**Bold _italic_ end** and ~~strike~~ and \u0060code\u0060 \u{1F600} **\u65E5\u672C\u8A9E**');
 assert.equal(result.text,'Bold italic end and strike and code \u{1F600} \u65E5\u672C\u8A9E');
 assert.deepEqual(marksOf(result),[{text:'Bold ',styles:['bold']},{text:'italic',styles:['bold','italic']},{text:' end',styles:['bold']},{text:'strike',styles:['strike']},{text:'code',styles:['code']},{text:'\u65E5\u672C\u8A9E',styles:['bold']}]);
 assert.doesNotThrow(()=>validateInlineMarks(result.text,result.marks));
 const triple=renderMarkdownInline('***Both*** and **bold *nested***');
 assert.equal(triple.text,'Both and bold nested');assert.deepEqual(marksOf(triple),[{text:'Both',styles:['bold','italic']},{text:'bold ',styles:['bold']},{text:'nested',styles:['bold','italic']}]);
});

test('escaped syntax, intraword underscores, unmatched delimiters and unmatched ticks remain literal',()=>{
 for(const value of ['snake_case_value','one**two','**open','~~open','\u0060open **literal**']) {
  const result=renderMarkdownInline(value);assert.equal(result.text,value);assert.deepEqual(result.marks,[]);
 }
 const escaped=renderMarkdownInline('\\*literal\\* and **bold**');assert.equal(escaped.text,'*literal* and bold');assert.deepEqual(marksOf(escaped),[{text:'bold',styles:['bold']}]);
});

test('inline code treats delimiters and links as literal, accepts matching tick lengths and normalizes code whitespace',()=>{
 const result=renderMarkdownInline('**before \u0060**[x](Other.md)**\u0060 after** and \u0060\u0060 a\u0060b \u0060\u0060');
 assert.equal(result.text,'before **[x](Other.md)** after and a\u0060b');
 assert.ok(marksOf(result).some(m=>m.text==='**[x](Other.md)**'&&m.styles.join(',')==='bold,code'));
 assert.equal(renderMarkdownInline('\u0060 line\nnext \u0060').text,'line next');
});

test('HTML stays literal while escaped entities become safe text and source remains available',async()=>{
 const source='# Page\n\n**&lt;script&gt;** &amp; &#x1F600;\n\n<aside>**literal HTML**</aside>';
 const {plan,result}=await prepare(source),page=result.body.pages[1];
 assert.equal(page.blocks[1].data.text,'<script> & \u{1F600}');assert.equal(page.blocks[2].data.text,'<aside>**literal HTML**</aside>');
 assert.deepEqual(page.blocks[1].data.marks[0].styles,['bold']);assert.equal(page.blocks[2].data.marks,undefined);
 assert.equal(sourceOf(page),source);assert.ok(plan.warnings.some(w=>w.code==='HTML_AS_TEXT'));
});

test('formatted private page and attachment labels map to exact rendered spans without activating unsafe URLs',async()=>{
 const source='\u{1F600} **Before [**bold _label_**](Other.md) after** and [Bad](javascript:bad) and [Web](https://example.invalid/path)';
 const {plan,result}=await prepare(source),block=result.body.pages[1].blocks[0];
 assert.equal(plan.links.length,3);assert.equal(result.summary.convertedLinks,1);assert.equal(result.summary.unconvertedLinks,2);
 assert.equal(block.data.text,'\u{1F600} Before bold label after and [Bad](javascript:bad) and [Web](https://example.invalid/path)');
 assert.equal(block.data.links[0].label,'bold label');assert.equal(block.data.links[0].sourcePageId,'markdown-2');
 for(const ref of block.data.links)assert.equal(block.data.text.slice(ref.start,ref.end),ref.label);
 assert.ok(block.data.marks.every(mark=>!Object.hasOwn(mark,'href')));assert.doesNotThrow(()=>validateBlocks(result.body.pages[1].blocks));
});

test('quotes and nested blocks retain code-safe internal link positions with prefix-free editable text',async()=>{
 const source='> **See [Other](Other.md)**\n> > Nested _quote_\n\n- Parent\n  - [Child](Other.md)';
 const {result}=await prepare(source),page=result.body.pages[1],quote=page.blocks[0];
 assert.equal(quote.type,'quote');assert.equal(quote.data.text,'See Other');assert.equal(quote.data.links[0].start,4);assert.equal(quote.children[0].type,'quote');
 assert.equal(quote.children[0].data.text,'Nested quote');assert.equal(page.blocks[1].children[0].data.links[0].label,'Child');
 assert.doesNotThrow(()=>validateBlocks(page.blocks));
});

test('list continuation text remains on its owning list and sibling/dedent starts a new root',async()=>{
 const source='- first\n  continuation **bold**\n  - nested\n- sibling\n\nOutside';
 const {result}=await prepare(source),blocks=result.body.pages[1].blocks;
 assert.equal(blocks[0].data.text,'first\ncontinuation bold');assert.equal(blocks[0].children[0].data.text,'nested');
 assert.equal(blocks[1].type,'bulleted-list');assert.equal(blocks[1].data.text,'sibling');assert.equal(blocks[2].data.text,'Outside');
 assert.doesNotThrow(()=>validateBlocks(blocks));
});

test('unclosed fences and unsupported table/math/HTML retain exact source and a subset warning',async()=>{
 const source='# Page\n\n| A | B |\n| --- | --- |\n\n$$x$$\n\n\u0060\u0060\u0060js\n**literal**\n';
 const {plan,result}=await prepare(source);assert.ok(plan.warnings.some(w=>w.code==='MARKDOWN_SUBSET'));
 assert.equal(result.body.pages[1].blocks.at(-2).type,'code');assert.equal(result.body.pages[1].blocks.at(-2).data.text,'**literal**\n');
 assert.equal(sourceOf(result.body.pages[1]),source);
});

test('deep input remains bounded and retains every source item instead of producing invalid recursive payloads',async()=>{
 const source=Array.from({length:20},(_,i)=>'  '.repeat(i)+'- level '+i).join('\n');
 const {result}=await prepare(source),page=result.body.pages[1],items=flatten(page.blocks).filter(b=>b.type==='bulleted-list');
 assert.equal(items.length,20);assert.equal(sourceOf(page),source);assert.doesNotThrow(()=>validateBlocks(page.blocks));
 const depth=bs=>Math.max(0,...bs.map(b=>1+depth(b.children??[])));assert.ok(depth(page.blocks)<=9);
});

test('forged parent order, cycles, unsupported metadata and malformed code language are rejected',async()=>{
 const {plan}=await prepare('- parent\n  - child\n\n\u0060\u0060\u0060js\ncode\n\u0060\u0060\u0060');
 const cases=[p=>{p.pages[0].blocks[0].parentBlockId=p.pages[0].blocks[1].id;},p=>{p.pages[0].blocks[1].parentBlockId=p.pages[0].blocks[1].id;},p=>{p.pages[0].blocks[0].language='js';},p=>{p.pages[0].blocks[2].language='html onload=bad';},p=>{p.pages[0].blocks[0].listStyle='iframe';}];
 for(const corrupt of cases){const copy=structuredClone(plan);corrupt(copy);assert.throws(()=>prepareNotionImportBundle(copy,{expectedRevision:0,importId:'forged'}),{code:'INVALID_IMPORT_PLAN'});}
});

test('more than 1000 formatting runs split safely, including one long structured link label',async()=>{
 const label=Array.from({length:1201},()=> '**x** ').join(''),source='['+label+'](Other.md)';
 const {result}=await prepare(source),page=result.body.pages[1],blocks=page.blocks.filter(b=>b.data.purpose!=='import-source');
 assert.ok(blocks.length>1);assert.equal(blocks.map(b=>b.data.text).join(''),'x '.repeat(1201));assert.equal(result.summary.convertedLinks,1);
 for(const block of blocks){assert.ok(block.data.marks.length<=1000);for(const link of block.data.links)assert.equal(block.data.text.slice(link.start,link.end),link.label);}
 assert.doesNotThrow(()=>validateBlocks(page.blocks));assert.equal(sourceOf(page),source);
});

test('large fenced code remains editable code chunks while readonly Markdown source chunks reconstruct exactly',async()=>{
 const literal='a'.repeat(99999)+'\u{1F600}'+'z'.repeat(15),source='\u0060\u0060\u0060js\n'+literal+'\n\u0060\u0060\u0060';
 const {result}=await prepare(source),page=result.body.pages[1],code=page.blocks.filter(b=>b.type==='code'&&b.data.purpose!=='import-source');
 assert.equal(code.length,2);assert.equal(code.map(b=>b.data.text).join(''),literal);assert.equal(sourceOf(page),source);
 assert.ok(code.every(b=>b.data.sourcePart===undefined));assert.doesNotThrow(()=>validateBlocks(page.blocks));
});

test('parser block limits reject before returning a partial model and rendering does not mutate link guards',()=>{
 assert.throws(()=>parseMarkdownBlocks('- a\n  - b\n    - c','limited',2),{code:'MODEL_LIMIT'});
 const guards=scanMarkdownLinks('[**raw**](https://example.invalid) **formatted**'),before=structuredClone(guards);
 const result=renderMarkdownInline('[**raw**](https://example.invalid) **formatted**',{literalRanges:guards});
 assert.equal(result.text,'[**raw**](https://example.invalid) formatted');assert.deepEqual(guards,before);
});

test('formatted links survive explicit native CSV row mapping and staged attachment binding with exact nested offsets',async()=>{
 const source='# Page\n\n**[Database](Database.csv)**\n\n- Parent\n  - _[Other](Other.md)_\n\n**[File](asset.txt)**';
 const plan=await previewNotionImport(zip({'Page.md':source,'Other.md':'_**[Mapped](Page.md)**_','Database.csv':'Name,Note\nPage,literal','asset.txt':'Synthetic asset only'}));
 const asset=plan.entries.find(entry=>entry.path==='asset.txt'),settings={expectedRevision:0,importId:'mapped-formatted-assets',csvMode:'native',assets:[{sourceId:asset.id,assetId:'staged-fixture'}],rowPageMappings:[{collectionId:'collection-1',rowId:'collection-1-row-1',pageId:'page-1'}]};
 const result=prepareNotionImportBundle(plan,settings),mapped=result.body.pages.find(page=>page.sourceId==='markdown-1'),other=result.body.pages.find(page=>page.sourceId==='markdown-2');
 assert.equal(mapped.parentSourceId,'csv-1');assert.equal(result.body.collections[0].records[0].pageSourceId,'markdown-1');
 assert.equal(mapped.blocks[1].data.links[0].sourceCollectionId,'native-collection-1');assert.equal(mapped.blocks[2].children[0].data.links[0].sourcePageId,'markdown-2');
 assert.equal(other.blocks[0].data.links[0].sourcePageId,'markdown-1');assert.equal(other.blocks[0].data.text,'Mapped');
 assert.deepEqual(other.blocks[0].data.marks,[{start:0,end:6,styles:['bold','italic']}]);
 const assetBlock=mapped.blocks[3];assert.equal(assetBlock.data.text,'File');assert.equal(assetBlock.data.links[0].sourceAssetId,asset.id);
 assert.deepEqual(result.body.assets,[{sourceId:asset.id,assetId:'staged-fixture',pageSourceIds:['markdown-1']}]);
 for(const page of result.body.pages){assert.doesNotThrow(()=>validateBlocks(page.blocks));for(const block of flatten(page.blocks))for(const link of block.data.links??[])assert.equal(block.data.text.slice(link.start,link.end),link.label);}
 assert.equal(sourceOf(mapped),source);assert.equal(result.summary.convertedLinks,4);assert.equal(result.summary.unconvertedLinks,0);
 assert.deepEqual(result,prepareNotionImportBundle(plan,settings));
});
