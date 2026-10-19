export function consumeSetupAuthorization(location,history){
 const authorization=new URLSearchParams(location.hash.slice(1)).get('start')??'';
 if(authorization)history.replaceState(history.state,'',location.pathname+location.search);
 return authorization;
}
export async function setupRequest(path,{method='GET',body,authorization,accountId,signal}={}){
 const response=await fetch(path,{method,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000),headers:{...(body?{'Content-Type':'application/json'}:{}),...(authorization?{'X-Yumunio-Setup-Token':authorization}:{}),...(accountId?{'X-Yumunio-Expected-Account':accountId}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const value=await response.json();if(!response.ok)throw new Error(value?.error?.code??'SETUP_UNAVAILABLE');return value;
}
export function setupSettings(data,{initial=false}={}){
 const settings=Object.fromEntries([...data].filter(([key])=>key.startsWith('YUMUNIO_')));
 for(const provider of ['GOOGLE','GITHUB','DISCORD'])if(!initial&&data.get('provider_'+provider)!=='true'){settings['YUMUNIO_OAUTH_'+provider+'_CLIENT_ID']='';settings['YUMUNIO_OAUTH_'+provider+'_CLIENT_SECRET']=null;}
 return settings;
}
