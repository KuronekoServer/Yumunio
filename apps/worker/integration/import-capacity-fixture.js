import worker from './feed-fixture.js';

const fixturePaths=new Map([['/api/content/workspaces/feed-workspace/pages',300000],['/api/content/workspaces/feed-workspace/imports',768000]]);

export default {async fetch(request,env,context){
  const maxFixtureBytes=fixturePaths.get(new URL(request.url).pathname);
  if(request.method!=='POST'||maxFixtureBytes===undefined)return worker.fetch(request,env,context);
  // Miniflare's HTTP bridge can reset its sending socket when the production
  // body reader cancels an oversized upload or the account fence rejects before
  // reading it. Drain only these bounded synthetic fixture requests first, then
  // pass the same bytes and account headers to the production handler.
  // Removing Content-Length keeps the real 256000-byte streaming guard under
  // test; a transport error is never treated as a successful rejection.
  if(!request.body)throw new Error('Synthetic capacity-test body is required.');
  const reader=request.body.getReader(),chunks=[];let size=0;
  try{
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>maxFixtureBytes){await reader.cancel();throw new Error('Synthetic capacity-test body exceeds fixture bounds.');}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const headers=new Headers(request.headers);headers.delete('Content-Length');
  const forwarded=new Request(request.url,{method:request.method,headers,body:bytes});
  const response=await worker.fetch(forwarded,env,context),result=new Response(response.body,response);
  result.headers.set('X-Yumunio-Fixture-Received-Bytes',String(size));
  result.headers.set('X-Yumunio-Fixture-Forwarded-Length',forwarded.headers.get('Content-Length')===null?'absent':'present');
  return result;
}};
