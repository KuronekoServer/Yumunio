import {validatePersonalSnapshot} from './templates-model.js';
import {validatePageStarter} from './page-starter.js';

const paragraph = key => ({type:'paragraph', data:{text:key}});
const heading = key => ({type:'heading', data:{text:key, level:2}});
const section = key => [heading(key), paragraph('')];
const check = key => ({type:'checklist', data:{text:key, checked:false}});
const definitions = [
  {id:'blank', icon:'page', blocks:[paragraph('')]},
  {id:'meeting', icon:'people', blocks:[...section('meeting.context'), ...section('meeting.agenda'), ...section('meeting.notes'), ...section('meeting.decisions'), heading('meeting.actions'), check('meeting.action')]},
  {id:'project', icon:'flag', blocks:[...section('project.goal'), ...section('project.scope'), ...section('project.milestones'), heading('project.tasks'), check('project.firstTask'), ...section('project.risks'), ...section('project.links')]},
  {id:'issue', icon:'issue', blocks:[...section('issue.summary'), ...section('issue.environment'), ...section('issue.steps'), ...section('issue.expected'), ...section('issue.actual'), heading('issue.done'), check('issue.condition')]},
  {id:'tasks', icon:'check', blocks:[paragraph('tasks.intro'), heading('tasks.today'), check('tasks.first'), check('tasks.second'), heading('tasks.next'), check('tasks.later'), ...section('tasks.notes')]},
  {id:'guide', icon:'book', blocks:[...section('guide.purpose'), ...section('guide.before'), heading('guide.steps'), {type:'numbered-list',data:{text:'guide.first'}}, {type:'numbered-list',data:{text:'guide.second'}}, ...section('guide.trouble'), ...section('guide.related')]},
  {id:'weekly', icon:'calendar', blocks:[...section('weekly.goal'), ...section('weekly.progress'), ...section('weekly.learning'), ...section('weekly.blockers'), heading('weekly.next'), check('weekly.action')]}
];

/** These are independent page bodies. No source page, attachment or DB IDs travel with them. */
export function pageStarters(t){
  const rows=definitions.map(({id,icon,blocks})=>({
    id:'starter:'+id, icon, name:t('pageTemplates.'+id+'.name'), description:t('pageTemplates.'+id+'.description'),
    snapshot:{title:t('pageTemplates.'+id+'.name'), blocks:blocks.map(block=>({...structuredClone(block),data:{...block.data,text:block.data.text?t('pageTemplates.body.'+block.data.text):''}}))}
  }));
  const recipe=(id,type,icon,keys)=>({id:'starter:'+id,icon,name:t('pageTemplates.'+id+'.name'),description:t('pageTemplates.'+id+'.description'),snapshot:{title:t('pageTemplates.'+id+'.name'),blocks:[]},starter:validatePageStarter({type,labels:Object.fromEntries(keys.map(key=>[key,t('pageTemplates.structured.'+(type==='simple-table'?'simple.':'database.')+key)]))})});
  rows.splice(1,0,
    ...[['kanban','board','board'],['taskTable','table','table']].map(([id,type,icon])=>recipe(id,type,icon,['intro','name','status','assignee','due','todo','doing','done','first','second','third','summary','details','tableView','boardView','calendarView','timelineView'])),
    recipe('simpleTable','simple-table','table',['intro','item','value','note','first']));
  return rows;
}

/** Mint a new tree only on submission, preserving literal text, formatting and nesting. */
export function instantiatePageStarter(snapshot, createId=()=>crypto.randomUUID()){
  const safe=validatePersonalSnapshot(snapshot), used=new Set();
  const mint=()=>{const id=createId();if(typeof id!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).test(id)||used.has(id))throw new TypeError('INVALID_TEMPLATE_BLOCK_ID');used.add(id);return id;};
  const copy=blocks=>blocks.map(block=>({id:mint(),type:block.type,...(block.data?{data:structuredClone(block.data)}:{}),...(block.children?{children:copy(block.children)}:{})}));
  const blocks=copy(safe.blocks);
  return blocks.length?blocks:[{id:mint(),type:'paragraph',data:{text:''}}];
}

export function matchingPageStarters(templates,query){
  const normalize=value=>value.normalize('NFKC').toLowerCase();
  const terms=normalize(query.trim()).split(/\s+/).filter(Boolean);
  return templates.filter(item=>terms.every(term=>normalize(item.name+' '+item.description).includes(term)));
}
