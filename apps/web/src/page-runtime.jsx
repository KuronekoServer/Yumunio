'use client';
import {useEffect,useState} from 'react';

// These fixed, repository-owned controller names never come from saved pages or a URL.
const loaded = new Map();
function startController(name) {
  if (!/^\/[a-z][a-z-]*\.js$/.test(name)) throw new Error('INVALID_PAGE_CONTROLLER');
  if (!loaded.has(name)) loaded.set(name, import(/* webpackIgnore: true */ name));
  return loaded.get(name);
}

/** Next owns the page markup; mature editor widgets own only their DOM mounting regions. */
export function PageRuntime({controllers=[],htmlClass='',bodyClass='',titleSuffix='',offline=false}) {
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    document.documentElement.className=htmlClass;
    document.body.className=bodyClass;
    document.querySelector('title')?.setAttribute('data-instance-title',titleSuffix);
    if(offline)document.body.dataset.offlineView='true';else delete document.body.dataset.offlineView;
    let active=true;
    (async()=>{for(const name of controllers)await startController(name);})().catch(()=>{if(active)setFailed(true);});
    return()=>{active=false;};
  },[controllers,htmlClass,bodyClass,titleSuffix,offline]);
  return failed?<p className="runtime-error" role="alert">画面を読み込めませんでした。接続を確認して再読み込みしてください。<a href="">再読み込み / Reload</a></p>:null;
}
