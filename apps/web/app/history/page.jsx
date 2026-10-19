import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"ページ履歴"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","history.css","design-system.css"]} controllers={["/history.js"]} htmlClass="" bodyClass="">
<header className="account-header"><a className="brand" href="/" data-instance-label=""><span data-instance-name="">Yumunio</span></a><a href="/account" id="history-account">アカウント</a></header><main id="history-app" className="history-app"><p role="status">確認しています…</p></main><footer className="account-footer"><a href="./LICENSE.txt">MIT License</a></footer>
 </PageFrame>;
}
