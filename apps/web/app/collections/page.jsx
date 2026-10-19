import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"コレクション"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["preferences.css","collections.css","share.css","groups-settings.css","settings-dialog.css","design-system.css"]} controllers={["/collections.js"]} htmlClass="preferences-page" bodyClass="">
<a className="skip-link" href="#collections-main">コレクションへ移動</a><header className="preferences-header"><a className="brand" data-instance-label="" href="/"><img data-instance-logo="" width="24" height="24" alt="Yumunio" hidden/><svg data-instance-default-logo="" data-instance-brand-mark="" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 4h16v16H4zM4 10h16M10 4v16"/></svg><span data-instance-name="">Yumunio</span></a><nav id="collections-nav" aria-label="ナビゲーション"></nav></header><main id="collections-main" tabIndex="-1"><p role="status">読み込んでいます…</p></main><dialog id="collections-dialog" aria-labelledby="collections-dialog-title"></dialog><footer className="preferences-footer"><span data-instance-organization="" hidden></span><a href="./LICENSE.txt">MIT License</a></footer><noscript>この画面には JavaScript が必要です。</noscript>
 </PageFrame>;
}
