const NO_STORE_HEADERS = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0",
  "pragma": "no-cache",
  "expires": "0",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  "surrogate-control": "no-store",
  "access-control-allow-origin": "*",
} as const;

export function getNoStoreHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers(NO_STORE_HEADERS);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return headers;
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: getNoStoreHeaders({ "content-type": "application/json; charset=utf-8" }),
  });
}

export function textResponse(body: string, contentType: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: getNoStoreHeaders({ "content-type": contentType }),
  });
}

export function binaryResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
  return new Response(bytes as unknown as BodyInit, {
    status,
    headers: getNoStoreHeaders({ "content-type": contentType }),
  });
}
