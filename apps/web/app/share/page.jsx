import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"共有とアクセス"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","share.css","design-system.css"]} controllers={["/share.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#share-main">本文へ移動</a><header className="share-header"><a className="brand" href="/account" data-instance-label=""><img data-instance-logo="" width="24" height="24" alt="Yumunio" hidden/><svg data-instance-default-logo="" data-instance-brand-mark="" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M6 3h13v18H6zM3 8h7M3 13h7M3 18h7"/></svg><span data-instance-name="">Yumunio</span></a><div className="share-preferences"><label><span id="share-theme-label">テーマ</span><select id="share-theme" aria-labelledby="share-theme-label"></select></label><label><span id="share-language-label">言語</span><select id="share-language" aria-labelledby="share-language-label"><option value="ja">日本語</option><option value="en">English</option></select></label></div></header><div className="share-shell"><aside className="share-sidebar"><h2 id="share-sidebar-title">共有設定</h2><a id="share-back" href="/account">ワークスペースへ</a><a id="share-account" href="/account">アカウント</a><p id="share-sidebar-note"></p><a href="./LICENSE.txt">MIT License</a></aside><main id="share-main" className="share-main" tabIndex="-1"><p role="status">読み込み中…</p></main></div><dialog id="share-modal" aria-labelledby="share-modal-title"></dialog>
 </PageFrame>;
}
