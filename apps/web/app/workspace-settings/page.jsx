import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"ワークスペース設定"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["workspace.css","workspace-settings.css","groups-settings.css","design-system.css"]} controllers={["/workspace-settings.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#settings-content">本文へ移動</a>
  <div id="settings-app"><p className="startup" role="status">読み込み中… / Loading…</p></div>
 </PageFrame>;
}
