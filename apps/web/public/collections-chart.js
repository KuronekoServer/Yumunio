import {validateChartResult} from './chart-model.js';
const svgNamespace='http://www.w3.org/2000/svg';
export function barLayout(groups){
 const numbers=groups.map(group=>group.result??0),low=Math.min(0,...numbers),high=Math.max(0,...numbers),span=high-low||1;
 return{zero:180+(0-low)/span*400,bars:numbers.map(value=>({x:180+(Math.min(0,value)-low)/span*400,width:Math.abs(value)/span*400}))};
}
export function donutSegments(groups){
 const maximum=Math.max(0,...groups.map(group=>group.result??0));if(!maximum)return[];
 const scaled=groups.map(group=>(group.result??0)/maximum),total=scaled.reduce((sum,value)=>sum+value,0);let offset=0;
 return scaled.map((value,index)=>{const fraction=value/total,result={index,fraction,offset};offset+=fraction;return result;});
}
/** SVG nodes have fixed tag names and numeric attributes; user labels are text only. */
export function renderCollectionChart({chart,view,properties,document,labels}){
 validateChartResult(chart,view,properties);
 const html=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
 const svg=(tag,attributes={},text)=>{const node=document.createElementNS(svgNamespace,tag);for(const[key,value]of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;return node;};
 const section=html('section',undefined,'collection-chart');
 section.append(html('p',labels.boundary,'hint'));
 if(chart.status==='unavailable'){section.append(html('p',labels.reasons[chart.reason],'chart-unavailable'));return section;}
 if(!chart.groups.length){section.append(html('p',labels.empty,'collection-empty'));return section;}
 const label=value=>value===null?labels.emptyGroup:typeof value==='boolean'?labels[value?'yes':'no']:value;
 const number=value=>value===null?labels.noNumbers:String(value);
 const picture=svg('svg',{role:'img','aria-labelledby':'collection-chart-title collection-chart-description',class:'chart-picture',viewBox:view.chart.type==='bar'?'0 0 640 '+(chart.groups.length*36+30):'0 0 400 400'});
 picture.append(svg('title',{id:'collection-chart-title'},labels.title),svg('desc',{id:'collection-chart-description'},labels.description));
 if(view.chart.type==='bar'){
  const layout=barLayout(chart.groups);picture.append(svg('line',{x1:layout.zero,x2:layout.zero,y1:8,y2:chart.groups.length*36+4,class:'chart-axis'}));
  chart.groups.forEach((group,index)=>{const y=index*36+10,full=label(group.value),short=Array.from(full).slice(0,20).join('');picture.append(svg('text',{x:170,y:y+17,'text-anchor':'end',class:'chart-label'},(index+1)+'. '+short+(short!==full?'…':'')));
   const bar=svg('rect',{x:layout.bars[index].x,y,width:Math.max(1,layout.bars[index].width),height:24,class:'chart-bar'});bar.append(svg('title',{},full+': '+number(group.result)));picture.append(bar,svg('text',{x:630,y:y+17,'text-anchor':'end',class:'chart-number'},number(group.result)));
  });
 }else{
  const radius=130,length=2*Math.PI*radius,segments=donutSegments(chart.groups);
  picture.append(svg('circle',{cx:200,cy:200,r:radius,class:'chart-ring'}));
  for(const segment of segments){if(segment.fraction===0)continue;const circle=svg('circle',{cx:200,cy:200,r:radius,fill:'none','stroke-width':65,'stroke-dasharray':segment.fraction*length+' '+length,'stroke-dashoffset':-segment.offset*length,transform:'rotate(-90 200 200)',class:'chart-segment chart-tone-'+segment.index%5});circle.append(svg('title',{},(segment.index+1)+'. '+label(chart.groups[segment.index].value)+': '+number(chart.groups[segment.index].result)));picture.append(circle);}
  picture.append(svg('text',{x:200,y:205,'text-anchor':'middle',class:'chart-center'},segments.length?labels.donut:labels.zeroTotal));
 }
 section.append(html('div',undefined,'chart-picture-frame'));section.lastChild.append(picture);
 const table=html('table',undefined,'chart-table'),caption=html('caption',labels.tableTitle),head=html('thead'),header=html('tr');for(const text of ['#',labels.group,labels.value,labels.count,...(view.chart.aggregation==='count'?[]:[labels.numericCount])]){const cell=html('th',text);cell.scope='col';header.append(cell);}head.append(header);const body=html('tbody');chart.groups.forEach((group,index)=>{const row=html('tr');[String(index+1),label(group.value),number(group.result),String(group.count),...(view.chart.aggregation==='count'?[]:[String(group.numericCount)])].forEach((text,i)=>{const cell=html(i===1?'th':'td',text);if(i===1)cell.scope='row';row.append(cell);});body.append(row);});table.append(caption,head,body);section.append(html('div',undefined,'chart-table-frame'));section.lastChild.append(table);return section;
}
