/* Fixed-window per-source-IP rate limit backed by DynamoDB (RateLimitTable
   in template.yaml) — the Lambda-level complement to that template's API
   Gateway throttling and WAF rate-based rule, neither of which can tell
   one abusive IP apart from a burst of legitimate traffic on their own
   (DefaultRouteSettings is one shared budget for the whole API; the WAF
   rule only sees requests that reach a matched route). This runs first in
   handler.js, before requireUser(), so it also covers repeated
   invalid-token attempts — a verification failure never reaches a route
   handler, so nothing downstream of auth would ever see that traffic.

   Deliberately fails OPEN: if the DynamoDB call itself errors (missing
   table, a transient outage, a permissions problem), the request is
   allowed through and the failure is only logged. Rate limiting is
   defense in depth on top of auth + RLS, not a hard dependency the whole
   API should go down over. */

import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({});

const WINDOW_SECONDS = 60;
const DEFAULT_LIMIT = 60; // requests per source IP per window

export class RateLimitError extends Error {}

/** Throws RateLimitError only when this source IP is confirmed over the
    limit for the current window — every other outcome (not configured,
    under the limit, or the DynamoDB call itself failing) returns
    normally. See the top-of-file comment for why failures fail open. */
export async function checkRateLimit(event) {
  const tableName = process.env.RATE_LIMIT_TABLE;
  if (!tableName) return; // not wired up (e.g. local/test) — nothing to check against

  const ip = event.requestContext?.http?.sourceIp || "unknown";
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE) || DEFAULT_LIMIT;
  // Fixed window, not a sliding log: simple and atomic via one conditional
  // UpdateItem, at the cost of allowing up to 2x the limit right at a
  // window boundary. Acceptable for what this is defending against
  // (sustained abuse, not a precise quota).
  const windowBucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const pk = `ip#${ip}#${windowBucket}`;
  const expiresAt = Math.floor(Date.now() / 1000) + WINDOW_SECONDS * 2; // TTL cleanup, not correctness-critical

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: pk } },
        UpdateExpression:
          "ADD #c :incr SET expiresAt = if_not_exists(expiresAt, :ttl)",
        ConditionExpression: "attribute_not_exists(#c) OR #c < :limit",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: {
          ":incr": { N: "1" },
          ":limit": { N: String(limit) },
          ":ttl": { N: String(expiresAt) },
        },
      }),
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      throw new RateLimitError(
        "Too many requests from this address — try again in a moment.",
      );
    // Anything else (misconfigured table, a transient DynamoDB issue) —
    // log and allow the request through. See top-of-file comment.
    console.error(`[rateLimit] ${err.message}`);
  }
}
