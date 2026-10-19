'use client';
import {useEffect,useRef,useState} from 'react';
import {SetupPage} from './setup-page.jsx';
import {consumeSetupAuthorization} from './setup-client.js';

export function SetupScreen(){
  const authorization=useRef(''),[ready,setReady]=useState(false);
  useEffect(()=>{authorization.current=consumeSetupAuthorization(location,history);setReady(true);return()=>{authorization.current='';};},[]);
  return ready?<SetupPage initialAuthorization={authorization.current}/>:<main className="route-loading" role="status">読み込んでいます… / Loading…</main>;
}
