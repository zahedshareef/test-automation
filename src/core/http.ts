/** Small fetch wrapper with timeouts and readable errors (no secrets in messages). */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function http<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 30_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    const safeUrl = url.replace(/([?&](?:token|key|apikey)=)[^&]+/gi, '$1***');
    throw new HttpError(res.status, `${init.method ?? 'GET'} ${safeUrl} failed: ${res.status} ${res.statusText} ${text.slice(0, 500)}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
