import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidAccessKey, validatePublicOrigin } from '../src/config.js';

test('public origins are explicit HTTP(S) origins without hidden paths, credentials or normalization', () => {
  for (const value of ['http://127.0.0.1:8790', 'https://workspace.example']) assert.equal(validatePublicOrigin(value), value);
  for (const value of ['', null, {}, ' https://workspace.example', 'https://workspace.example/', 'https://workspace.example/path', 'https://user:pass@workspace.example', 'https://workspace.example?query', 'https://workspace.example#hash', 'ws://workspace.example', 'https://WORKSPACE.example']) assert.throws(() => validatePublicOrigin(value), /public origin/);
});

test('access key configuration uses the same length and type limits in both runtimes', () => {
  for (const value of ['', null, true, 'a'.repeat(31), 'b'.repeat(4097)]) assert.equal(isValidAccessKey(value), false);
  assert.equal(isValidAccessKey('a'.repeat(32)), true);
  assert.equal(isValidAccessKey('b'.repeat(4096)), true);
});
