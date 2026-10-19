import test from 'node:test';
import assert from 'node:assert/strict';
import {MailError,createCloudflareMailer,readMailConfig} from '../../../packages/identity/src/mail.js';
import {createWorkerMailer,readWorkerMailConfig} from '../mail.js';

const env={YUMUNIO_MAIL_DRIVER:'cloudflare',YUMUNIO_SMTP_FROM:'notes@example.invalid',YUMUNIO_SMTP_REPLY_TO:'support@example.invalid'},message={to:'reader@example.invalid',subject:'Yumunio: メール確認',text:'Synthetic local mail preview.'};
test('native Email Service uses the configured sender and validates provider acceptance',async()=>{
 const sent=[],binding={async send(value){sent.push(value);return{messageId:'fixture-email-123'};}},config=readWorkerMailConfig({...env,EMAIL:binding}),mailer=createWorkerMailer(config,{EMAIL:binding});
 assert.deepEqual(await mailer.send(message),{status:'accepted',id:'fixture-email-123'});assert.deepEqual(sent,[{from:env.YUMUNIO_SMTP_FROM,...message,replyTo:env.YUMUNIO_SMTP_REPLY_TO}]);await mailer.close();await assert.rejects(mailer.send(message),error=>error.code==='MAIL_SEND_FAILED');
});
test('invalid messages never reach the Cloudflare binding and provider diagnostics are redacted',async()=>{
 let calls=0;const binding={async send(){calls++;throw new Error('PRIVATE_PROVIDER_DIAGNOSTIC');}},mailer=createCloudflareMailer(readMailConfig(env),binding);
 await assert.rejects(mailer.send({...message,subject:'Header\r\nBcc: injected@example.invalid'}),error=>error.code==='MAIL_INVALID_MESSAGE');assert.equal(calls,0);
 await assert.rejects(mailer.send(message),error=>error instanceof MailError&&error.code==='MAIL_SEND_FAILED'&&!String(error).includes('PRIVATE_PROVIDER'));assert.equal(calls,1);
 for(const result of [undefined,{}, {messageId:''},{messageId:'unsafe\r\nheader'}])await assert.rejects(createCloudflareMailer(readMailConfig(env),{async send(){return result;}}).send(message),error=>error.code==='MAIL_SEND_FAILED');
});
test('Cloudflare close waits for admitted email without accepting new sends',async()=>{
 let complete;const mailer=createCloudflareMailer(readMailConfig(env),{send:()=>new Promise(resolve=>{complete=resolve;})}),pending=mailer.send(message);let closed=false;const close=mailer.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);await assert.rejects(mailer.send(message),error=>error.code==='MAIL_SEND_FAILED');complete({messageId:'fixture-completed'});await pending;await close;assert.equal(closed,true);
});
test('Workers require the native binding and reject the prohibited SMTP port',()=>{
 assert.throws(()=>readWorkerMailConfig(env),error=>error.code==='MAIL_CONFIGURATION');
 assert.throws(()=>readWorkerMailConfig({YUMUNIO_MAIL_DRIVER:'smtp',YUMUNIO_SMTP_FROM:env.YUMUNIO_SMTP_FROM,YUMUNIO_SMTP_HOST:'smtp.example.invalid',YUMUNIO_SMTP_PORT:'25'}),error=>error.code==='MAIL_CONFIGURATION');
});
test('Workers SMTP reuses the mandatory-TLS transport and its explicit recipient acceptance checks',async()=>{
 const config=readWorkerMailConfig({YUMUNIO_MAIL_DRIVER:'smtp',YUMUNIO_SMTP_FROM:env.YUMUNIO_SMTP_FROM,YUMUNIO_SMTP_HOST:'smtp.example.invalid'});let options,sent;
 const mailer=createWorkerMailer(config,{}, {createTransport(value){options=value;return{async sendMail(value){sent=value;return{accepted:[message.to],rejected:[]};}};}});
 await mailer.send(message);assert.equal(options.requireTLS,true);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.opportunisticTLS,false);assert.equal(options.logger,false);assert.deepEqual(sent.envelope.to,[message.to]);await mailer.close();
});
