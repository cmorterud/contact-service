import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError, MAX_BODY_BYTES, isEmail, parseBody, parseOrigins, validateSubmission } from '../src/validation';

test('normalizes plain text, line endings, and Unicode', () => {
  assert.deepEqual(validateSubmission({ message: '  Cafe\u0301\r\nHello\rWorld\t!  ', replyEmail: ' person+tag@example.com ' }), {
    message: 'Café\nHello\nWorld\t!', replyEmail: 'person+tag@example.com',
  });
});

test('accepts 2000 Unicode code points and rejects 2001', () => {
  assert.equal(Array.from(validateSubmission({ message: '🙂'.repeat(2000) }).message).length, 2000);
  assert.throws(() => validateSubmission({ message: 'x'.repeat(2001) }), InputError);
});

for (const [label, input] of [
  ['null', null], ['array', []], ['string', 'hi'], ['missing message', {}],
  ['non-string message', { message: 123 }], ['empty', { message: '' }],
  ['whitespace', { message: ' \n\t ' }], ['null character', { message: 'a\0b' }],
  ['control', { message: 'a\u0001b' }], ['bidi', { message: 'a\u202eb' }],
  ['surrogate', { message: '\ud800' }], ['extra field', { message: 'Hi', recipient: 'other@example.com' }],
  ['prototype field', JSON.parse('{"message":"Hi","__proto__":{}}') as unknown],
  ['empty reply', { message: 'Hi', replyEmail: '' }], ['null reply', { message: 'Hi', replyEmail: null }],
  ['CRLF header', { message: 'Hi', replyEmail: 'person@example.com\r\nBcc: other@example.com' }],
  ['trailing header newline', { message: 'Hi', replyEmail: 'person@example.com\n' }],
] as const) {
  test(`rejects invalid submission: ${label}`, () => {
    assert.throws(() => validateSubmission(input), (error: unknown) => error instanceof InputError && error.statusCode === 400);
  });
}

test('preserves markup literally in the plain text body', () => {
  assert.equal(validateSubmission({ message: '<script>alert(1)</script>\nBcc: any@example.com' }).message,
    '<script>alert(1)</script>\nBcc: any@example.com');
});

for (const email of ['a@b.example', 'first.last+tag@example.com', 'a_b@example.co.uk']) {
  test(`accepts mailbox ${email}`, () => assert.equal(isEmail(email), true));
}
for (const email of ['a@b', 'a..b@example.com', '.a@example.com', 'a.@example.com', 'a@-b.com',
  'a@b-.com', 'a@b..com', 'a@@b.com', 'a,b@example.com', 'Name <a@example.com>',
  'a@example.com\r\n', 'ü@example.com', `${'a'.repeat(65)}@example.com`, `a@${'b'.repeat(64)}.com`]) {
  test(`rejects mailbox ${JSON.stringify(email)}`, () => assert.equal(isEmail(email), false));
}

test('parses UTF-8 and base64 JSON with a decoded byte limit', () => {
  const json = JSON.stringify({ message: 'Hello 🙂' });
  assert.deepEqual(parseBody(json, false), { message: 'Hello 🙂' });
  assert.deepEqual(parseBody(Buffer.from(json).toString('base64'), true), { message: 'Hello 🙂' });
  assert.throws(() => parseBody('x'.repeat(MAX_BODY_BYTES + 1), false), { statusCode: 413 });
  assert.throws(() => parseBody(Buffer.alloc(MAX_BODY_BYTES + 1).toString('base64'), true), { statusCode: 413 });
  // The byte limit, rather than JS string length, applies to Unicode bodies.
  assert.throws(() => parseBody('🙂'.repeat(5000), false), { statusCode: 413 });
});

for (const body of ['', '{', 'undefined']) {
  test(`rejects malformed JSON ${JSON.stringify(body)}`, () => assert.throws(() => parseBody(body, false), { statusCode: 400 }));
}
test('rejects invalid base64 and invalid UTF-8', () => {
  assert.throws(() => parseBody('not base64!', true), { statusCode: 400 });
  assert.throws(() => parseBody(Buffer.from([0xff]).toString('base64'), true), { statusCode: 400 });
});

test('requires an exact HTTPS origin allowlist', () => {
  assert.deepEqual(parseOrigins('https://example.com, https://other.example:8443,https://example.com'),
    ['https://example.com', 'https://other.example:8443']);
  for (const value of ['', '*', 'https://*.example.com', 'http://example.com', 'https://example.com/',
    'https://example.com/path', 'https://user:pass@example.com', 'null', 'https://example.com,']) {
    assert.throws(() => parseOrigins(value));
  }
});
