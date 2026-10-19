import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"添付ファイル"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","attachments.css","design-system.css"]} controllers={["/attachments.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#attachments-app">本文へ</a><header className="account-header"><a className="brand" href="/" data-instance-label=""><svg data-instance-default-logo="" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 3h12v18H6zM3 7h6M3 12h6M3 17h6"/></svg><img data-instance-logo="" hidden width="28" height="28" alt=""/><span data-instance-name="">Yumunio</span></a><label className="language-label"><span id="language-label">言語</span><select id="language" aria-label="言語"><option value="ja">日本語</option><option value="en">English</option></select></label><a id="attachments-account" href="/account#account">アカウント</a></header><main id="attachments-app" className="attachments-app" tabIndex="-1"><p role="status">読み込み中…</p></main><dialog id="attachments-confirm" aria-labelledby="attachments-confirm-title"></dialog><footer className="account-footer"><a id="attachments-preferences" href="/preferences">個人設定</a><a href="./LICENSE.txt">MIT License</a></footer>
 </PageFrame>;
}
