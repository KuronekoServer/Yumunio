import {renderToString} from './math-renderer.js';

export function renderEquation(text,document=globalThis.document){
 const host=document.createElement('div');host.className='equation-preview';host.setAttribute('translate','no');
 const template=document.createElement('template');
 // MathML needs no remote assets or inline styles. KaTeX escapes source and rejects trusted HTML/URLs.
 template.innerHTML=renderToString(text,{output:'mathml',displayMode:true,throwOnError:false,trust:false,strict:'error',maxExpand:200,maxSize:20});
 host.append(template.content.cloneNode(true));return host;
}
