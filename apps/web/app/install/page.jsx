import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"ノート"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["install.css","design-system.css"]} controllers={["/install.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#install-app">本文へ移動</a><header><a href="./account" data-instance-name="">Yumunio</a><a href="./account" id="account-link">アカウント</a></header><main id="install-app"><h1>アプリとして使う</h1><p>読み込み中…</p></main><noscript>JavaScriptを有効にしてください。 / Enable JavaScript.</noscript>
 </PageFrame>;
}
