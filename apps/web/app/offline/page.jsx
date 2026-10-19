import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"ノート"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["install.css","design-system.css"]} controllers={["/install.js"]} htmlClass="" bodyClass="" offline>
<a className="skip-link" href="#install-app">本文へ移動</a><header><a href="./notes" data-instance-name="">Yumunio</a><a href="./account" id="account-link">アカウント</a></header><main id="install-app"><h1>接続を確認してください</h1><p>アカウントのページにはサーバーへの接続が必要です。</p><a href="/notes">端末内のページを開く / Open local pages</a></main><noscript>アカウントの編集はオンラインで行ってください。 / Account editing requires a connection.</noscript>
 </PageFrame>;
}
