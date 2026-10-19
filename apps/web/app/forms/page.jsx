import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"フォーム"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["preferences.css","forms.css","design-system.css"]} controllers={["/forms.js"]} htmlClass="preferences-page" bodyClass="">
<a className="skip-link" href="#forms-main">フォームへ移動</a>
<header className="preferences-header"><a className="brand" data-instance-label="" href="/" aria-label="Yumunio"><img data-instance-logo="" width="24" height="24" alt="Yumunio" hidden/><svg data-instance-default-logo="" data-instance-brand-mark="" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M6 3h11a2 2 0 0 1 2 2v15H6zM3 7h6M3 12h6M3 17h6M12 8l5-5 3 3-5 5h-3z"/></svg><span data-instance-name="">Yumunio</span></a><nav id="forms-nav" aria-label="ナビゲーション"></nav></header>
<main id="forms-main" className="forms-main" tabIndex="-1"><p role="status">フォームを読み込んでいます…</p></main>
<dialog id="forms-dialog" aria-labelledby="forms-dialog-title"></dialog>
<footer className="preferences-footer"><span data-instance-organization="" hidden></span><a href="./LICENSE.txt">MIT License</a></footer>
<noscript>フォームを利用するには JavaScript を有効にしてください。</noscript>
 </PageFrame>;
}
