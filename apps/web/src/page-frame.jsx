import {PageRuntime} from './page-runtime.jsx';

export function PageFrame({styles=[],controllers=[],modulePreloads=[],htmlClass='',bodyClass='',titleSuffix='',offline=false,children}) {
  return <>{[...new Set([...controllers,...modulePreloads])].map(name=><link key={name} rel="modulepreload" href={'/'+name}/>)}{styles.map(name=><link key={name} rel="stylesheet" href={'/'+name}/>)}{children}<PageRuntime controllers={controllers} htmlClass={htmlClass} bodyClass={bodyClass} titleSuffix={titleSuffix} offline={offline}/></>;
}
