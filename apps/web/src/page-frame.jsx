import {PageRuntime} from './page-runtime.jsx';
import {MotionUI} from './ui-motion.jsx';

export function PageFrame({styles=[],controllers=[],modulePreloads=[],htmlClass='',bodyClass='',titleSuffix='',offline=false,children}) {
  const animated=modulePreloads.includes('workspace.js')||controllers.includes('collections.js');
  const content=<>{[...new Set([...controllers,...modulePreloads])].map(name=><link key={name} rel="modulepreload" href={'/'+name+(name==='workspace.js'&&process.env.NEXT_PUBLIC_EDITOR_VERSION?'?v='+process.env.NEXT_PUBLIC_EDITOR_VERSION:'')}/>)}{[...styles,...(animated?['ui-motion.css']:[])].map(name=><link key={name} rel="stylesheet" href={'/'+name}/>)}{children}<PageRuntime controllers={controllers} htmlClass={htmlClass} bodyClass={bodyClass} titleSuffix={titleSuffix} offline={offline}/></>;
  return animated?<MotionUI>{content}</MotionUI>:content;
}
