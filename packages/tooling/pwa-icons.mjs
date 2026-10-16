import {deflateSync} from 'node:zlib';
const crc=bytes=>{let result=0xffffffff;for(const byte of bytes){result^=byte;for(let bit=0;bit<8;bit++)result=(result>>>1)^(result&1?0xedb88320:0);}return(result^0xffffffff)>>>0;};
function chunk(type,bytes){const name=Buffer.from(type),body=Buffer.concat([name,bytes]),output=Buffer.alloc(bytes.length+12);output.writeUInt32BE(bytes.length,0);body.copy(output,4);output.writeUInt32BE(crc(body),output.length-4);return output;}
/** The existing book glyph, rasterized from fixed geometric primitives; no external font or bitmap input. */
export function createPwaIcon(size){
  if(![192,512].includes(size))throw new TypeError('Invalid PWA icon size.');
  const pixels=Buffer.alloc((size*4+1)*size),rect=(x,y,left,top,right,bottom)=>x>=left&&x<right&&y>=top&&y<bottom;
  for(let row=0;row<size;row++)for(let col=0;col<size;col++){
    const x=(col+.5)*32/size,y=(row+.5)*32/size;
    const paper=rect(x,y,11,7,24,25)&&!rect(x,y,13,9,22,23),binding=[11,16,21].some(line=>rect(x,y,7,line-1,15,line+1));
    const color=paper||binding?[255,255,255,255]:[56,87,114,255],offset=row*(size*4+1)+1+col*4;for(let c=0;c<4;c++)pixels[offset+c]=color[c];
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
