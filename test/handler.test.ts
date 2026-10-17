import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { SendEmailCommandInput } from '@aws-sdk/client-ses';
import { createHandler } from '../src/handler';

const config = { senderEmail: 'sender@example.com', recipientEmail: 'private-destination@example.com', allowedOrigins: ['https://example.com'] };
function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0', routeKey: 'POST /contact', rawPath: '/contact', rawQueryString: '',
    headers: { 'content-type': 'application/json', origin: 'https://example.com' },
    requestContext: {
      accountId: '123456789012', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      requestId: 'request', routeKey: 'POST /contact', stage: '$default', time: '', timeEpoch: 0,
      http: { method: 'POST', path: '/contact', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
    },
    body: JSON.stringify({ message: 'Hello', replyEmail: 'visitor@example.com' }), isBase64Encoded: false,
    ...overrides,
  };
}

test('sends one structured text email using only configured addresses', async () => {
  const send = mock.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'never-exposed' }));
  const log = mock.method(console, 'error', () => {});
  try {
    const result = await createHandler(send, () => config)(event());
    assert.equal(result.statusCode, 200);
    assert.deepEqual(send.mock.calls[0]?.arguments[0], {
      Source: config.senderEmail,
      Destination: { ToAddresses: [config.recipientEmail] },
      ReplyToAddresses: ['visitor@example.com'],
      Message: {
        Subject: { Data: 'New website contact submission', Charset: 'UTF-8' },
        Body: { Text: { Data: 'Hello', Charset: 'UTF-8' } },
      },
    });
    assert.equal(send.mock.callCount(), 1);
    assert.equal(log.mock.callCount(), 0);
    for (const privateValue of [config.recipientEmail, config.senderEmail, 'visitor@example.com', 'Hello', 'never-exposed']) {
      assert.equal(JSON.stringify(result).includes(privateValue), false);
    }
    assert.equal(result.headers?.['cache-control'], 'no-store');
  } finally { log.mock.restore(); }
});

test('supports absent replyEmail, absent Origin, and base64 request bodies', async () => {
  const send = mock.fn(async (_input: SendEmailCommandInput) => ({}));
  const result = await createHandler(send, () => config)(event({
    headers: { 'content-type': 'application/json; charset=utf-8' }, isBase64Encoded: true,
    body: Buffer.from(JSON.stringify({ message: ' Hi\r\nthere ' })).toString('base64'),
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(send.mock.calls[0]?.arguments[0].ReplyToAddresses, undefined);
  assert.equal(send.mock.calls[0]?.arguments[0].Message?.Body?.Text?.Data, 'Hi\nthere');
});

for (const [label, overrides, status] of [
  ['malformed JSON', { body: '{' }, 400],
  ['empty body', { body: undefined }, 400],
  ['array body', { body: '[]' }, 400],
  ['unknown recipient field', { body: '{"message":"Hi","recipientEmail":"other@example.com"}' }, 400],
  ['invalid email', { body: '{"message":"Hi","replyEmail":"bad"}' }, 400],
  ['oversize body', { body: 'x'.repeat(16 * 1024 + 1) }, 413],
  ['unsupported content type', { headers: { 'content-type': 'text/plain' } }, 415],
  ['missing content type', { headers: {} }, 415],
  ['compressed content', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, 415],
  ['untrusted origin', { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }, 403],
  ['null origin', { headers: { 'content-type': 'application/json', origin: 'null' } }, 403],
  ['wrong path', { rawPath: '/other' }, 404],
] satisfies Array<[string, Partial<APIGatewayProxyEventV2>, number]>) {
  test(`rejects ${label} before calling SES`, async () => {
    const send = mock.fn(async () => ({}));
    const result = await createHandler(send, () => config)(event(overrides));
    assert.equal(result.statusCode, status);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(JSON.stringify(result).includes(config.recipientEmail), false);
  });
}

test('does not send for the wrong HTTP method', async () => {
  const request = event();
  request.requestContext.http.method = 'GET';
  const send = mock.fn(async () => ({}));
  assert.equal((await createHandler(send, () => config)(request)).statusCode, 404);
  assert.equal(send.mock.callCount(), 0);
});

test('returns a generic failure and emits only a fixed metric marker for SES errors', async () => {
  const send = mock.fn(async () => { throw new Error(`${config.recipientEmail}: Hello visitor@example.com`); });
  const log = mock.method(console, 'error', () => {});
  try {
    const result = await createHandler(send, () => config)(event());
    assert.equal(result.statusCode, 503);
    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(log.mock.calls.map((call) => call.arguments), [['{"event":"delivery_failed"}']]);
    assert.equal(result.body, '{"message":"Unable to accept the message. Please try again later."}');
  } finally { log.mock.restore(); }
});

test('configuration errors are caught without leaking private details', async () => {
  const send = mock.fn(async () => ({}));
  const log = mock.method(console, 'error', () => {});
  try {
    const result = await createHandler(send, () => { throw new Error(config.recipientEmail); })(event());
    assert.equal(result.statusCode, 503);
    assert.equal(send.mock.callCount(), 0);
    assert.equal(JSON.stringify(result).includes(config.recipientEmail), false);
    assert.deepEqual(log.mock.calls[0]?.arguments, ['{"event":"delivery_failed"}']);
  } finally { log.mock.restore(); }
});
