import { validatePublicSnapshot } from './publication-data.js';
import {renderSimpleTable} from './table-block-view.js';

export function renderPublicationBody(snapshot, document = globalThis.document, labels = {}) {
  const safe = validatePublicSnapshot(snapshot);
  const fragment = document.createDocumentFragment();
  function visit(blocks, parent) {
    let previousList = null, previousType = null;
    for (const block of blocks) {
      let element, childParent;
      if(block.type==='table'){previousList=null;previousType=null;element=renderSimpleTable(block.data,document);parent.append(element);childParent=parent;}
      else if(block.type==='toggle'){
        previousList=null;previousType=null;element=document.createElement('details');element.className='publication-block';const summary=document.createElement('summary');summary.textContent=block.text;element.append(summary);parent.append(element);childParent=element;
      }
      else if (block.type === 'bulleted-list' || block.type === 'numbered-list') {
        if (previousType !== block.type) {
          previousList = document.createElement(block.type === 'bulleted-list' ? 'ul' : 'ol');
          previousList.className = 'publication-block';
          parent.append(previousList);
        }
        previousType = block.type;
        element = document.createElement('li');
        element.textContent = block.text;
        previousList.append(element);
        childParent = element;
      } else {
        previousList = null;
        previousType = null;
        const tag = block.type === 'divider' ? 'hr' : block.type === 'heading' ? 'h' + (block.level + 1) : block.type === 'heading1' ? 'h2' : block.type === 'heading2' ? 'h3' : ['quote','callout'].includes(block.type) ? 'blockquote' : 'p';
        element = document.createElement(tag);
        element.className = 'publication-block';
        if (block.type === 'checklist') {
          element.classList.add('publication-check');
          const check = document.createElement('span');
          check.textContent = block.checked ? '☑' : '☐';
          check.setAttribute('role', 'img');
          check.setAttribute('aria-label', block.checked ? labels.checked || 'Checked' : labels.unchecked || 'Unchecked');
          element.append(check, document.createTextNode(block.text));
          element.setAttribute('data-checked', String(block.checked));
        } else if (block.type !== 'divider') element.textContent = block.text;
        parent.append(element);
        childParent = parent;
      }
      if (block.children?.length) {
        const children = document.createElement('div');
        children.className = 'publication-children';
        visit(block.children, children);
        childParent.append(children);
      }
    }
  }
  visit(safe.blocks, fragment);
  return fragment;
}
