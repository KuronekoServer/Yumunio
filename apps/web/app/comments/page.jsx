import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"· コメント"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","comments.css","design-system.css"]} controllers={["/comments.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#comments-app">本文へ</a><header className="account-header"><a className="brand" href="/" data-instance-label=""><span data-instance-name="">Yumunio</span></a><a href="/account" id="comments-account">アカウント</a></header><main id="comments-app" className="comments-app" tabIndex="-1"><p role="status">確認しています…</p></main><dialog id="comments-confirm" aria-labelledby="comments-confirm-title"></dialog><footer className="account-footer"><a href="./LICENSE.txt">MIT License</a></footer>
 </PageFrame>;
}
