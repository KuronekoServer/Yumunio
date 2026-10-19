import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"公開ページ"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","publication.css","design-system.css"]} controllers={["/site.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#site-app">本文へ</a><header className="account-header"><a className="brand" href="/" data-instance-label=""><svg data-instance-default-logo="" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 3h12v18H6zM3 7h6M3 12h6M3 17h6"/></svg><img data-instance-logo="" hidden width="28" height="28" alt=""/><span data-instance-name="">Yumunio</span></a><label className="language-label"><span id="language-label">言語</span><select id="language" aria-label="言語"><option value="ja">日本語</option><option value="en">English</option></select></label></header><main id="site-app" className="site-app" tabIndex="-1"><p role="status">公開ページを読み込んでいます…</p></main><footer className="account-footer"><span data-instance-name="">Yumunio</span><a href="./LICENSE.txt">MIT License</a></footer>
 </PageFrame>;
}
