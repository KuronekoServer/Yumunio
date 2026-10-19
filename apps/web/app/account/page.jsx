import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"アカウント"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","design-system.css"]} controllers={["/account.js"]} htmlClass="" bodyClass="">
<header className="account-header"><a className="brand" data-instance-label="" href="/" aria-label="Yumunio"><img data-instance-logo="" width="24" height="24" alt="Yumunio" hidden/><svg data-instance-default-logo="" data-instance-brand-mark="" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M6 3h11a2 2 0 0 1 2 2v15H6zM3 7h6M3 12h6M3 17h6M12 8l5-5 3 3-5 5h-3z"/></svg><span data-instance-name="">Yumunio</span></a><label className="language-label"><span id="language-label">表示言語</span><select id="language" aria-labelledby="language-label"><option value="ja">日本語</option><option value="en">English</option></select></label></header>
<main id="account-main" className="account-main"><p role="status">確認しています…</p></main>
<footer className="account-footer"><a id="back-link" href="/">ノートを開く</a><p id="privacy-note"></p><span data-instance-organization="" hidden></span><a href="./LICENSE.txt">MIT License</a></footer>
 </PageFrame>;
}
