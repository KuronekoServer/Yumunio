export function inlineDomFixture(t) {
  const previous=new Map(['document','Node','NodeFilter'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const textNodes=root=>root.nodeType===3?[root]:root.childNodes.flatMap(textNodes);
  const top=node=>node.parentElement?top(node.parentElement):node;
  function offset(root,node,at){if(root===node){if(node.nodeType===3)return at;return node.childNodes.slice(0,at).reduce((n,child)=>n+child.textContent.length,0);}let value=0;for(const child of root.childNodes){if(child===node||child.contains?.(node))return value+offset(child,node,at);value+=child.textContent.length;}throw new Error('node outside range');}
  class Range {
    constructor(){this.startContainer=null;this.endContainer=null;this.startOffset=0;this.endOffset=0;}
    setStart(node,at){this.startContainer=node;this.startOffset=at;}setEnd(node,at){this.endContainer=node;this.endOffset=at;}
    selectNodeContents(node){this.setStart(node,0);this.setEnd(node,node.nodeType===3?node.textContent.length:node.childNodes.length);}
    cloneRange(){return Object.assign(new Range(),this);}
    toString(){const root=top(this.startContainer);return root.textContent.slice(offset(root,this.startContainer,this.startOffset),offset(root,this.endContainer,this.endOffset));}
  }
  class Text {
    nodeType=3;nodeName='#text';parentElement=null;
    constructor(value,doc){this.data=value;this.ownerDocument=doc;}
    get textContent(){return this.data;}set textContent(value){this.data=String(value);}
    replaceData(start,count,value){this.data=this.data.slice(0,start)+value+this.data.slice(start+count);}
  }
  class Element {
    nodeType=1;parentElement=null;childNodes=[];attributes=new Map();listeners=new Map();isConnected=true;hidden=false;
    constructor(tag,doc){this.nodeName=tag.toUpperCase();this.ownerDocument=doc;}
    get textContent(){return this.childNodes.map(node=>node.textContent).join('');}set textContent(value){this.replaceChildren(this.ownerDocument.createTextNode(String(value)));}
    set innerHTML(value){throw new Error('HTML must not be interpreted');}
    append(...children){for(const node of children){if(node.parentElement){const at=node.parentElement.childNodes.indexOf(node);node.parentElement.childNodes.splice(at,1);}node.parentElement=this;this.childNodes.push(node);}}
    replaceChildren(...children){for(const child of this.childNodes)child.parentElement=null;this.childNodes=[];this.append(...children);}
    setAttribute(key,value){this.attributes.set(key,String(value));}getAttribute(key){return this.attributes.get(key)??null;}removeAttribute(key){this.attributes.delete(key);}
    contains(node){return node===this||this.childNodes.some(child=>child===node||child.contains?.(node));}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);}
    dispatch(type,properties={}){const event={target:this,prevented:false,preventDefault(){this.prevented=true;},stopPropagation(){},...properties};for(const fn of this.listeners.get(type)??[])fn(event);return event;}
    focus(){this.ownerDocument.activeElement=this;this.ownerDocument.focusCalls++;}scrollIntoView(){this.ownerDocument.scrollCalls++;}
  }
  const selection={range:null,anchorNode:null,focusNode:null,anchorOffset:0,focusOffset:0,get rangeCount(){return this.range?1:0;},get isCollapsed(){return !this.range||this.range.startContainer===this.range.endContainer&&this.range.startOffset===this.range.endOffset;},getRangeAt(){return this.range;},removeAllRanges(){this.range=null;},addRange(range){this.range=range;this.anchorNode=range.startContainer;this.anchorOffset=range.startOffset;this.focusNode=range.endContainer;this.focusOffset=range.endOffset;},setBaseAndExtent(anchor,anchorOffset,focus,focusOffset){const root=top(anchor),a=offset(root,anchor,anchorOffset),b=offset(root,focus,focusOffset),range=new Range();if(a<=b){range.setStart(anchor,anchorOffset);range.setEnd(focus,focusOffset);}else{range.setStart(focus,focusOffset);range.setEnd(anchor,anchorOffset);}this.range=range;this.anchorNode=anchor;this.anchorOffset=anchorOffset;this.focusNode=focus;this.focusOffset=focusOffset;}};
  const document={activeElement:null,focusCalls:0,scrollCalls:0,createElement(tag){return new Element(tag,this);},createTextNode(value){return new Text(value,this);},createRange(){return new Range();},getSelection(){return selection;},createTreeWalker(root){const nodes=textNodes(root);let index=0;return{nextNode(){return nodes[index++]??null;}};},addEventListener(){},querySelectorAll(){return[];}};
  Object.defineProperties(globalThis,{document:{value:document,configurable:true},Node:{value:{TEXT_NODE:3,ELEMENT_NODE:1},configurable:true},NodeFilter:{value:{SHOW_TEXT:4},configurable:true}});
  t.after(()=>{for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return{document,selection,textNodes,select(element,start,end=start,direction='forward'){element.focus();const locate=at=>{let length=at;for(const node of textNodes(element)){if(length<=node.textContent.length)return[node,length];length-=node.textContent.length;}return[element,element.childNodes.length];};const[a,ao]=locate(start),[b,bo]=locate(end);if(direction==='backward')selection.setBaseAndExtent(b,bo,a,ao);else selection.setBaseAndExtent(a,ao,b,bo);}};
}
