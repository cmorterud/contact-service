export const MAX_MESSAGE_CHARACTERS = 2_000;
export const MAX_BODY_BYTES = 16 * 1_024;

export function parseOrigins(value: string): string[] {
  const origins = value.split(',').map((origin) => origin.trim());
  if (!origins.length || origins.some((origin) => {
    try {
      const url = new URL(origin);
      return origin.includes('*') || url.origin !== origin || url.protocol !== 'https:';
    } catch {
      return true;
    }
  })) throw new Error('Invalid origin configuration');
  return [...new Set(origins)];
}

export class InputError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface Submission {
  readonly message: string;
  readonly replyEmail?: string;
}

// Deliberately supports a conservative ASCII mailbox subset, without display names.
// A structured SES command handles headers; no user input becomes a raw header.
export function isEmail(value: string): boolean {
  if (value.length > 254 || !/^[\x21-\x7e]+$/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local = '', domain = ''] = parts;
  return local.length >= 1 && local.length <= 64 &&
    /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local) &&
    domain.length <= 253 && domain.includes('.') && domain.split('.').every(
      (label) => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

export function validateSubmission(input: unknown): Submission {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError(400, 'Expected a JSON object.');
  }
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some((key) => key !== 'message' && key !== 'replyEmail')) {
    throw new InputError(400, 'Only message and replyEmail are accepted.');
  }
  if (typeof data.message !== 'string') {
    throw new InputError(400, 'A message is required.');
  }
  // Normalize line endings and Unicode. Reject invisible controls and unpaired
  // surrogates rather than silently rewriting potentially misleading content.
  const message = data.message.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (!message || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Surrogate}/u.test(message)) {
    throw new InputError(400, 'Message contains no text or unsupported characters.');
  }
  if (Array.from(message).length > MAX_MESSAGE_CHARACTERS) {
    throw new InputError(400, 'Message must be at most 2000 characters.');
  }
  let replyEmail: string | undefined;
  if (data.replyEmail !== undefined) {
    // Reject CR/LF before trimming so header-injection attempts never normalize away.
    if (typeof data.replyEmail !== 'string' || /[\r\n]/.test(data.replyEmail)) {
      throw new InputError(400, 'replyEmail must be a valid email address.');
    }
    replyEmail = data.replyEmail.trim();
    if (!isEmail(replyEmail)) {
      throw new InputError(400, 'replyEmail must be a valid email address.');
    }
  }
  return { message, ...(replyEmail ? { replyEmail } : {}) };
}

export function parseBody(body: string | undefined, isBase64Encoded: boolean): unknown {
  if (!body) throw new InputError(400, 'A JSON body is required.');
  if (Buffer.byteLength(body, 'utf8') > (isBase64Encoded ? Math.ceil(MAX_BODY_BYTES / 3) * 4 : MAX_BODY_BYTES)) {
    throw new InputError(413, 'Request body is too large.');
  }
  let text = body;
  if (isBase64Encoded) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) {
      throw new InputError(400, 'Malformed request body.');
    }
    const bytes = Buffer.from(body, 'base64');
    if (bytes.length > MAX_BODY_BYTES) throw new InputError(413, 'Request body is too large.');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new InputError(400, 'Malformed request body.');
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError(400, 'Malformed JSON.');
  }
}
