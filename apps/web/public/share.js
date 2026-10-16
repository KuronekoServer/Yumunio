import {mountSharingPage} from './sharing-page.js';
const controller=mountSharingPage({root:document.body});
window.addEventListener('pagehide',()=>controller.destroy(),{once:true});
