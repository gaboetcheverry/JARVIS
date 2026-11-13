export interface GmailMessageItem {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string;
}

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailAuthError';
  }
}

interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

interface GmailRawMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailPayloadPart & {
    headers?: Array<{ name?: string; value?: string }>;
  };
}

function decodeBase64UrlUtf8(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBodyFromPayload(payload?: GmailPayloadPart): string {
  if (!payload) return '';

  const findPart = (part: GmailPayloadPart, targetMime: string): string | null => {
    if (part.mimeType === targetMime && part.body?.data) {
      return decodeBase64UrlUtf8(part.body.data);
    }
    if (part.parts) {
      for (const child of part.parts) {
        const found = findPart(child, targetMime);
        if (found) return found;
      }
    }
    return null;
  };

  const plainText = findPart(payload, 'text/plain');
  if (plainText) return plainText.trim();

  const htmlText = findPart(payload, 'text/html');
  if (htmlText) return stripHtmlTags(htmlText);

  if (payload.body?.data) {
    return decodeBase64UrlUtf8(payload.body.data).trim();
  }

  return '';
}

function getHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string
): string {
  if (!headers) return '';
  const target = name.toLowerCase();
  return headers.find((h) => h.name?.toLowerCase() === target)?.value || '';
}

export async function searchGmailMessages(
  accessToken: string,
  query: string,
  maxResults = 8
): Promise<GmailMessageItem[]> {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
  });
  if (query.trim()) {
    params.set('q', query.trim());
  }

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (listRes.status === 401 || listRes.status === 403) {
    throw new GmailAuthError(
      'La sesión de Gmail expiró o requiere permisos nuevamente. Vuelve a iniciar sesión con Google.'
    );
  }

  if (!listRes.ok) {
    throw new Error(`Error consultando Gmail (${listRes.status}).`);
  }

  const listData = (await listRes.json()) as {
    messages?: Array<{ id: string; threadId: string }>;
  };

  const messageRefs = listData.messages || [];
  if (messageRefs.length === 0) return [];

  const details = await Promise.all(
    messageRefs.map(async (ref) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
          ref.id
        )}?format=full`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (msgRes.status === 401 || msgRes.status === 403) {
        throw new GmailAuthError(
          'La sesión de Gmail expiró o requiere permisos nuevamente. Vuelve a iniciar sesión con Google.'
        );
      }

      if (!msgRes.ok) return null;

      const raw = (await msgRes.json()) as GmailRawMessage;
      const headers = raw.payload?.headers;

      return {
        id: raw.id,
        threadId: raw.threadId,
        subject: getHeader(headers, 'Subject') || '(Sin asunto)',
        from: getHeader(headers, 'From') || 'Remitente desconocido',
        date: getHeader(headers, 'Date') || '',
        snippet: raw.snippet || '',
        body: extractBodyFromPayload(raw.payload) || raw.snippet || '',
      } satisfies GmailMessageItem;
    })
  );

  return details.filter((m): m is GmailMessageItem => m !== null);
}
