import {PageFrame} from '../../src/page-frame.jsx';
import {WorkspacePage} from '../../src/workspace-page.jsx';

export const metadata={title:"ワークスペース"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["workspace.css","inline-editor.css","mentions.css","preferences.css","workspace-settings.css","share.css","settings-dialog.css","workspace-picker.css","teamspace-settings.css","groups-settings.css","design-system.css"]} controllers={[]} modulePreloads={['workspace.js']} htmlClass="" bodyClass="">
<WorkspacePage/>
 </PageFrame>;
}
