/* Thin HTTP adapter for the existing Lambda handler (src/handler.js),
   used by the Docker/Openship dev deployment path — see
   docs/superpowers/specs/2026-08-25-dev-deployment-vercel-openship-design.md.
   handler.js itself is unmodified: it already reads only a handful of
   fields off a plain `event` object, so this file's only job is to
   build that same shape from a real HTTP request and translate the
   {statusCode, headers, body} result back into an HTTP response. */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { handler } from "./handler.js";

// Intentionally duplicated from handler.js's own (unexported) CORS_HEADERS,
// since handler.js is not to be modified — keep these values in sync with
// handler.js's if either ever changes. Used only for this file's 500
// fallback below, so a request that fails unexpectedly still gets a clean,
// visible error instead of an opaque CORS failure in the browser.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "authorization,content-type,x-active-tenant",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB, matching API Gateway's own payload limit

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large."), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
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

export function createApp(handlerFn = handler) {
  return createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const url = new URL(req.url, "http://localhost");
      const event = buildEvent(req, body, url);
      const result = await handlerFn(event);
      res.writeHead(result.statusCode, result.headers || {});
      res.end(result.body ?? "");
    } catch (err) {
      try {
        if (!res.headersSent) {
          const statusCode = err && err.statusCode === 413 ? 413 : 500;
          console.error("[server] unexpected error", err.stack || err.message);
          res.writeHead(statusCode, {
            "Content-Type": "application/json",
            ...CORS_HEADERS,
          });
          res.end(JSON.stringify({ ok: false, error: "Request failed." }));
        }
      } catch (writeErr) {
        console.error(
          "[server] failed to write error response",
          writeErr.stack || writeErr.message,
        );
      }
    }
  });
}

// Only start listening when run directly (`node src/server.js`), not
// when imported by tests. Compared via pathToFileURL (not a manual
// `file://${...}` template) so this still matches on paths containing
// spaces (e.g. macOS `~/My Projects/...`).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT) || 8080;
  createApp().listen(port, () => {
    console.log(`[server] listening on :${port}`);
  });
}
