import test from 'node:test';
import assert from 'node:assert/strict';
import {assertChargedPublicFormRate} from './fixtures/public-forms-flow.js';

const rate=(minuteStart,minuteCount,hourStart,hourCount)=>({formId:'synthetic-form',minuteStart,minuteCount,hourStart,hourCount});

test('real-clock form acceptance verifies one exact charge in an unchanged window',()=>{
 assertChargedPublicFormRate(null,rate(60000,1,0,1),{startedAt:60001,finishedAt:60002});
 assertChargedPublicFormRate(rate(60000,2,0,5),rate(60000,3,0,6),{startedAt:60001,finishedAt:60002});
});

test('a request crossing a minute boundary permits either actual window but never loses an hourly charge',()=>{
 const before=rate(60000,3,0,3),interval={startedAt:119999,finishedAt:120001};
 assertChargedPublicFormRate(before,rate(60000,4,0,4),interval);
 assertChargedPublicFormRate(before,rate(120000,1,0,4),interval);
 assert.throws(()=>assertChargedPublicFormRate(before,rate(120000,1,0,1),interval));
});

test('an actual hour boundary resets both windows and still charges exactly once',()=>{
 const before=rate(3540000,3,0,9),interval={startedAt:3599999,finishedAt:3600001};
 assertChargedPublicFormRate(before,rate(3540000,4,0,10),interval);
 assertChargedPublicFormRate(before,rate(3600000,1,3600000,1),interval);
 assert.throws(()=>assertChargedPublicFormRate(before,rate(3600000,2,3600000,2),interval));
});

test('counter assertions reject skipped/double charges, unrelated or stale windows and another form',()=>{
 const before=rate(60000,2,0,5),interval={startedAt:60001,finishedAt:60002};
 for(const after of [rate(60000,2,0,5),rate(60000,4,0,7),rate(0,1,0,6),rate(120000,1,0,6),{...rate(60000,3,0,6),formId:'another-form'}])assert.throws(()=>assertChargedPublicFormRate(before,after,interval));
 assert.throws(()=>assertChargedPublicFormRate(before,rate(60000,3,0,6),{startedAt:60002,finishedAt:60001}));
});
