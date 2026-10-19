import {MailError,createCloudflareMailer,createHttpMailer,readMailConfig} from '@yumunio/identity/mail';
import {createSmtpMailer} from '@yumunio/identity/smtp';

export function readWorkerMailConfig(env) {
 const config=readMailConfig(env);
 if(config.driver==='cloudflare'&&typeof env.EMAIL?.send!=='function'||config.driver==='smtp'&&config.port===25)throw new MailError('MAIL_CONFIGURATION');
 return config;
}

export function createWorkerMailer(config,env,options={}) {
 if(config.driver==='cloudflare')return createCloudflareMailer(config,env.EMAIL);
 if(config.driver==='smtp'){
  if(config.port===25)throw new MailError('MAIL_CONFIGURATION');
  return createSmtpMailer(config,options);
 }
 return createHttpMailer(config,options);
}
