import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SESClient, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-ses';
import { InputError, isEmail, parseBody, parseOrigins, validateSubmission } from './validation';

interface Configuration {
  readonly senderEmail: string;
  readonly recipientEmail: string;
  readonly allowedOrigins: readonly string[];
}

function readConfiguration(): Configuration {
  const senderEmail = process.env.SENDER_EMAIL ?? '';
  const recipientEmail = process.env.RECIPIENT_EMAIL ?? '';
  if (!isEmail(senderEmail) || !isEmail(recipientEmail)) throw new Error('Invalid mail configuration');
  return { senderEmail, recipientEmail, allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS ?? '') };
}

type SendMail = (input: SendEmailCommandInput) => Promise<unknown>;

function response(statusCode: number, message: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    body: JSON.stringify({ message }),
  };
}

export function createHandler(sendMail: SendMail, configuration: () => Configuration = readConfiguration) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      if (event.requestContext.http.method !== 'POST' || event.rawPath !== '/contact') {
        return response(404, 'Not found.');
      }
      const config = configuration();
      // HTTP API lowercases incoming header names. Origin checks also reject
      // disallowed browser submissions, but clients can forge or omit Origin.
      const origin = event.headers.origin;
      if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
        return response(403, 'Origin is not allowed.');
      }
      const contentType = event.headers['content-type'] ?? '';
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) {
        return response(415, 'Use application/json.');
      }
      if (event.headers['content-encoding'] && event.headers['content-encoding'].toLowerCase() !== 'identity') {
        return response(415, 'Content encoding is not supported.');
      }
      const submission = validateSubmission(parseBody(event.body, event.isBase64Encoded));
      await sendMail({
        Source: config.senderEmail,
        Destination: { ToAddresses: [config.recipientEmail] },
        ...(submission.replyEmail ? { ReplyToAddresses: [submission.replyEmail] } : {}),
        Message: {
          Subject: { Data: 'New website contact submission', Charset: 'UTF-8' },
          Body: { Text: { Data: submission.message, Charset: 'UTF-8' } },
        },
      });
      return response(200, 'Message accepted.');
    } catch (error: unknown) {
      if (error instanceof InputError) return response(error.statusCode, error.message);
      // Never log the event, SDK error, addresses, or message. Metric filter only.
      console.error(JSON.stringify({ event: 'delivery_failed' }));
      return response(503, 'Unable to accept the message. Please try again later.');
    }
  };
}

// Disable automatic send retries: an ambiguous network failure may already have
// delivered email. This service deliberately has no persistence or deduplication.
const ses = new SESClient({
  region: process.env.AWS_REGION,
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 1_000, requestTimeout: 4_000 },
});
export const handler = createHandler((input) => ses.send(new SendEmailCommand(input), {
  abortSignal: AbortSignal.timeout(5_000),
}));
