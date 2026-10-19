import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"このページへのリンク"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","backlinks.css","design-system.css"]} controllers={["/backlinks.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#backlinks-app">本文へ</a><header className="account-header"><a className="brand" href="/" data-instance-label=""><svg data-instance-default-logo="" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 3h12v18H6zM3 7h6M3 12h6M3 17h6"/></svg><img data-instance-logo="" hidden width="28" height="28" alt=""/><span data-instance-name="">Yumunio</span></a><nav id="backlinks-nav" aria-label="ナビゲーション"></nav></header><main id="backlinks-app" className="backlinks-app" tabIndex="-1"><p role="status">読み込み中…</p></main><footer className="account-footer"><a id="backlinks-account" href="/account#account">アカウント</a><a href="./LICENSE.txt">MIT License</a></footer>
 </PageFrame>;
}
