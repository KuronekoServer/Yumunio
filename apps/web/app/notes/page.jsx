import {PageFrame} from '../../src/page-frame.jsx';

export const metadata={title:"端末内デモ"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["styles.css","inline-editor.css","design-system.css"]} controllers={["/app.js"]} htmlClass="" bodyClass="">
<a className="skip-link" href="#workspace-content">本文に移動</a>
    <div id="app"></div>
    <dialog id="modal" className="modal" aria-labelledby="modal-heading"></dialog>
    <div id="toast" className="toast" role="status" aria-live="polite" hidden></div>
    <noscript>この端末内デモを操作するには JavaScript を有効にしてください。</noscript>
 </PageFrame>;
}
