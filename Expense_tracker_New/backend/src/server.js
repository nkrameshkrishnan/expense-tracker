/* Thin HTTP adapter for the existing Lambda handler (src/handler.js),
   used by the Docker/Openship dev deployment path — see
   docs/superpowers/specs/2026-08-25-dev-deployment-vercel-openship-design.md.
   handler.js itself is unmodified: it already reads only a handful of
   fields off a plain `event` object, so this file's only job is to
   build that same shape from a real HTTP request and translate the
   {statusCode, headers, body} result back into an HTTP response. */

import { createServer } from "node:http";
import { handler } from "./handler.js";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function buildEvent(req, body, url) {
  return {
    requestContext: {
      http: {
        method: req.method,
        sourceIp: req.socket.remoteAddress || "unknown",
      },
    },
    headers: req.headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body,
  };
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const url = new URL(req.url, "http://localhost");
      const event = buildEvent(req, body, url);
      const result = await handler(event);
      res.writeHead(result.statusCode, result.headers || {});
      res.end(result.body ?? "");
    } catch (err) {
      console.error("[server] unexpected error", err.stack || err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Request failed." }));
    }
  });
}

// Only start listening when run directly (`node src/server.js`), not
// when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8080;
  createApp().listen(port, () => {
    console.log(`[server] listening on :${port}`);
  });
}
