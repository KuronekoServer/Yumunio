import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"ワークスペース移行"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["account.css","workspace-settings.css","import.css","design-system.css"]} controllers={["/import-settings-navigation.js","/import.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#import-main">本文へ移動</a>
  <div className="settings-shell import-settings-shell" id="import-settings-shell">
    <aside className="settings-sidebar" id="import-settings-navigation" aria-label="設定">
      <a className="settings-brand" href="/account">Yumunio</a>
    </aside>
    <button className="settings-scrim" id="import-settings-scrim" type="button" tabIndex="-1" aria-label="設定メニューを閉じる"></button>
    <div className="settings-main" id="import-settings-main">
      <header className="account-header settings-topbar">
        <button className="button settings-mobile-toggle" id="import-settings-toggle" type="button" aria-controls="import-settings-navigation" aria-expanded="false" aria-label="設定メニューを開く">☰</button>
        <a className="import-settings-back" id="import-settings-back" href="/account#account">設定へ戻る</a>
        <label className="language-label"><span id="language-label">言語</span><select id="language" aria-label="言語"><option value="ja">日本語</option><option value="en">English</option></select></label>
      </header>
      <div className="settings-scroll" id="import-settings-scroll">
        <main className="import-main" id="import-main" tabIndex="-1"><p role="status">読み込み中…</p></main>
        <footer className="account-footer"><a id="account-back" href="/account">アカウントへ</a><a href="./LICENSE.txt">MIT License</a></footer>
      </div>
    </div>
  </div>
  <dialog id="import-confirm" aria-labelledby="import-confirm-heading"></dialog>
 </PageFrame>;
}
