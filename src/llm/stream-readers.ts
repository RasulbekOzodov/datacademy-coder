/** Line / NDJSON / SSE readers over a fetch body. Node 22: ReadableStream is async-iterable. */

export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf;
}

export async function* readNdjson<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of readLines(body)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      /* ignore malformed line */
    }
  }
}

export async function* readSse<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of readLines(body)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') return;
    try {
      yield JSON.parse(data) as T;
    } catch {
      /* ignore malformed event */
    }
  }
}

export async function fetchJson<T = unknown>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { ...init, signal: init.signal ?? controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function describeFetchError(err: unknown, baseUrl: string): string {
  const e = err as { cause?: { code?: string }; name?: string; message?: string };
  const code = e?.cause?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
    return `${baseUrl} javob bermayapti (${code}). Server ishga tushganini tekshiring.`;
  }
  if (e?.name === 'AbortError') return `${baseUrl}: so'rov vaqti tugadi.`;
  return e?.message ?? String(err);
}
