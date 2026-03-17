import test from "node:test";
import assert from "node:assert/strict";
import { binaryResponse, jsonResponse, textResponse } from "../services/api/http";

function assertNoStore(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("surrogate-control"), "no-store");
}

test("JSON response uses no-store headers", () => {
  assertNoStore(jsonResponse({ ok: true }));
});

test("text response uses no-store headers", () => {
  assertNoStore(textResponse("ok", "text/plain"));
});

test("binary response uses no-store headers", () => {
  assertNoStore(binaryResponse(new Uint8Array([1, 2, 3]), "application/octet-stream"));
});
