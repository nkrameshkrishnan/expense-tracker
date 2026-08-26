import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

async function withServer(fn, handlerFn) {
  const app = handlerFn === undefined ? createApp() : createApp(handlerFn);
  await new Promise((resolve) => app.listen(0, resolve));
  const { port } = app.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

test("OPTIONS returns 204 with CORS headers", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET,POST,OPTIONS",
    );
  });
});

test("GET without an Authorization header returns 401 with the auth error shape", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, { method: "GET" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: false,
      error: "Missing Authorization header.",
    });
  });
});

test("POST without an Authorization header returns 401, ignoring the body", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "getPlans" }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: false,
      error: "Missing Authorization header.",
    });
  });
});

test("buildEvent correctly maps body, queryStringParameters, and sourceIp onto the constructed event", async () => {
  let capturedEvent;
  const fakeHandler = async (event) => {
    capturedEvent = event;
    return { statusCode: 200, headers: {}, body: "{}" };
  };

  await withServer(async (base) => {
    const res = await fetch(`${base}/?year=2026`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "getPlans" }),
    });
    assert.equal(res.status, 200);
    assert.equal(capturedEvent.requestContext.http.method, "POST");
    assert.equal(capturedEvent.queryStringParameters.year, "2026");
    assert.equal(capturedEvent.body, '{"action":"getPlans"}');
    assert.equal(typeof capturedEvent.requestContext.http.sourceIp, "string");
  }, fakeHandler);
});
