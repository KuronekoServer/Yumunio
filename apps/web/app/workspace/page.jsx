import {PageFrame} from '../../src/page-frame.jsx';
import {WorkspacePage} from '../../src/workspace-page.jsx';
import '../../src/workspace-styles.css';

export const metadata={title:"ワークスペース"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} bundledStyles controllers={[]} modulePreloads={['workspace.js']} htmlClass="" bodyClass="">
<WorkspacePage/>
 </PageFrame>;
}
