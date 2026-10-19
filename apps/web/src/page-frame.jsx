import {PageRuntime} from './page-runtime.jsx';

export function PageFrame({styles=[],controllers=[],htmlClass='',bodyClass='',titleSuffix='',offline=false,children}) {
  return <>{styles.map(name=><link key={name} rel="stylesheet" href={'/'+name}/>)}{children}<PageRuntime controllers={controllers} htmlClass={htmlClass} bodyClass={bodyClass} titleSuffix={titleSuffix} offline={offline}/></>;
}
