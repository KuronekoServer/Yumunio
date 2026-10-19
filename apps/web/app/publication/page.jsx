import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"ページ公開"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","publication.css","design-system.css"]} controllers={["/publication.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#publication-app">本文へ</a><header className="account-header"><a className="brand" href="/" data-instance-label=""><svg data-instance-default-logo="" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 3h12v18H6zM3 7h6M3 12h6M3 17h6"/></svg><img data-instance-logo="" hidden width="28" height="28" alt=""/><span data-instance-name="">Yumunio</span></a><label className="language-label"><span id="language-label">言語</span><select id="language" aria-label="言語"><option value="ja">日本語</option><option value="en">English</option></select></label><a id="publication-account" href="/account#account">アカウント</a></header><main id="publication-app" className="publication-app" tabIndex="-1"><p role="status">読み込み中…</p></main><dialog id="publication-confirm" aria-labelledby="publication-confirm-title"></dialog><footer className="account-footer"><a id="publication-preferences" href="/preferences">個人設定</a><a href="./LICENSE.txt">MIT License</a></footer>
 </PageFrame>;
}
