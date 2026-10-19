import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"個人設定"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["preferences.css","design-system.css"]} controllers={["/preferences-page.js"]} htmlClass="preferences-page" bodyClass="">
<a className="skip-link" href="#preferences-main">設定へ移動</a>
<header className="preferences-header">
<a className="brand" data-instance-label="" href="/" aria-label="Yumunio"><img data-instance-logo="" width="24" height="24" alt="Yumunio" hidden/><svg data-instance-default-logo="" data-instance-brand-mark="" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M6 3h11a2 2 0 0 1 2 2v15H6zM3 7h6M3 12h6M3 17h6M12 8l5-5 3 3-5 5h-3z"/></svg><span data-instance-name="">Yumunio</span></a>
<nav aria-label="ナビゲーション" id="preferences-nav"></nav>
</header>
<main id="preferences-main" className="preferences-main" tabIndex="-1"><p role="status">個人設定を読み込んでいます…</p></main>
<footer className="preferences-footer"><span data-instance-organization="" hidden></span><a href="./LICENSE.txt">MIT License</a></footer>
<noscript>この画面を利用するには JavaScript を有効にしてください。</noscript>
 </PageFrame>;
}
