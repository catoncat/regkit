// Mailbox extraction contracts. The cloud-mail CLI itself is not exercised;
// the extractor + polling behavior is what must not regress (catch-all noise
// resistance, sender/subject matching, verify-link capture).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCodeExtractor, makeLinkExtractor, codeFromBody, createMailProvider, Mailbox } from '../src/mailbox.mjs';

test('code extractor ignores noise, matches sender + 6-digit code', () => {
  const extract = makeCodeExtractor({ senderSuffix: 'example.com', subjectRe: /verification code/i });
  const items = [
    { sender: 'newsletter@elsewhere.com', subject: 'Weekly digest', text_body: 'code 123456' },
    { sender: 'no-reply@example.com', subject: 'Your admin account verification code', text_body: 'Your code is 481516' },
    { sender: 'no-reply@example.com', subject: 'Other', text_body: 'code 999999' }, // wrong subject
  ];
  assert.equal(extract(items), '481516');
  // subject-only match with a wrong-length code is still skipped
  const bad = [{ sender: 'no-reply@example.com', subject: 'Your admin account verification code', text_body: 'code 12345' }];
  assert.equal(extract(bad), null);
});

test('codeFromBody falls back to first 6-digit run', () => {
  assert.equal(codeFromBody('Your code is 481516 today'), '481516');
  assert.equal(codeFromBody('no digits'), null);
});

test('link extractor matches host (+ optional path prefix)', () => {
  const extract = makeLinkExtractor({ host: 'app.example.com', pathPrefix: '/verify-email?token=' });
  const items = [
    { text_body: 'Click https://app.example.com/verify-email?token=abc123&x=1 to verify', html_body: '' },
  ];
  assert.ok(extract(items).startsWith('https://app.example.com/verify-email?token=abc123'));
  const noise = [{ text_body: 'https://evil.example.net/app.example.com/verify' }];
  assert.equal(extract(noise), null);
});

test('createMailProvider validates extractor presence and unknown modes', () => {
  assert.throws(() => createMailProvider('cloud-mail'), /requires an extract/);
  assert.throws(() => createMailProvider('bogus'), /unknown mailMode/);
  const none = createMailProvider('none');
  assert.equal(none.name, 'none');
});

test('Mailbox.waitFor polls until extract yields, then stops', async () => {
  const mb = new Mailbox({ cli: 'fake' });
  let calls = 0;
  mb.messages = async () => {
    calls++;
    if (calls < 3) return [{ sender: 'no-reply@example.com', subject: 'verification code', text_body: 'later' }];
    return [{ sender: 'no-reply@example.com', subject: 'Your admin account verification code', text_body: 'Your code is 481516' }];
  };
  const extract = makeCodeExtractor({ senderSuffix: 'example.com' });
  const code = await mb.waitFor('a@x.test', extract, { timeoutMs: 3000, intervalMs: 5 });
  assert.equal(code, '481516');
  assert.equal(calls, 3);
});

test('Mailbox.waitFor: all polls failing is reported as poll failure, not mail timeout', async () => {
  const mb = new Mailbox({ cli: 'fake' });
  mb.messages = async () => { throw new Error('spawn cloud-mail ENOENT'); };
  await assert.rejects(
    () => mb.waitFor('a@x.test', () => null, { timeoutMs: 30, intervalMs: 5 }),
    /mailbox poll never succeeded.*ENOENT/,
  );
});

test('Mailbox.waitFor: healthy polls with no match still report mail timeout', async () => {
  const mb = new Mailbox({ cli: 'fake' });
  mb.messages = async () => [];
  await assert.rejects(
    () => mb.waitFor('a@x.test', () => null, { timeoutMs: 30, intervalMs: 5 }),
    /no matching mail within/,
  );
});
