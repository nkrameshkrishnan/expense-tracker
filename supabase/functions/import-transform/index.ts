// Supabase Edge Function: import-transform
//
// Turns raw text extracted from a bank/card statement (PDF or messy CSV)
// into an array of rows shaped like this app's `transactions` table, using
// Claude. This exists only because the frontend is a static site on GitHub
// Pages — it can never hold the Anthropic API key itself (every visitor
// downloads every byte of JS shipped there), so the key lives here as an
// Edge Function secret instead, and the browser calls this function rather
// than the Anthropic API directly. See README.md's "GitHub Secrets cannot
// keep a secret in a static site" for the same reasoning applied to the
// Supabase keys.
//
// Deploy: handled by the Supabase MCP tool / `supabase functions deploy
// import-transform`. Before it will actually work, set the API key once:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// (or Project Settings -> Edge Functions -> Secrets in the dashboard).
// Until that secret exists, this function fails closed with a clear error
// rather than silently doing nothing.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Hard ceiling on the extracted text this will send to Claude. A normal
// statement (even a dense multi-page one) runs a few thousand characters;
// this is generous headroom while still bounding cost and the Edge
// Function's own 2s-CPU / wall-clock limits if someone points it at
// something enormous.
const MAX_TEXT_CHARS = 60_000;

const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: {
    text?: string;
    categories?: string[];
    payments?: string[];
    accounts?: string[];
    people?: string[];
    types?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const text = String(body.text || "").trim();
  if (!text) return json({ error: "No text to transform." }, 400);
  if (text.length > MAX_TEXT_CHARS)
    return json(
      { error: `Text is ${text.length} characters - over the ${MAX_TEXT_CHARS} limit. Split the statement and import in parts.` },
      400,
    );

  // --------------------------------------------------------------- auth
  // This function's URL is reachable by anyone who finds it - the anon key
  // alone proves nothing (same reasoning as every RLS policy in
  // schema.sql). Re-checking is_allowed_household_member() here, the same
  // function those policies call, is what stops a stranger from spending
  // your Anthropic credits: it evaluates auth.jwt() from the Authorization
  // header this request carries, so it only passes for a Google account
  // already on the allow-list.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization") || "";
  if (!supabaseUrl || !anonKey) {
    return json({ error: "Server misconfigured: SUPABASE_URL/ANON_KEY not set." }, 500);
  }
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: allowed, error: authError } = await supabase.rpc(
    "is_allowed_household_member",
  );
  if (authError || !allowed) {
    return json({ error: "Not authorized." }, 403);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json(
      { error: "ANTHROPIC_API_KEY is not set for this project's Edge Functions. Add it under Project Settings -> Edge Functions -> Secrets, then try again." },
      500,
    );
  }

  const categories = body.categories?.length ? body.categories : ["Miscellaneous"];
  const payments = body.payments || [];
  const accounts = body.accounts || [];
  const people = body.people || [];
  const types = body.types?.length ? body.types : ["Expense", "Income", "Transfer", "Dividends", "Refund"];

  const systemPrompt = `You extract transactions from bank/credit-card statement text for a household expense tracker.

Return every transaction you can find via the extract_transactions tool. Rules:
- amount is always a positive number - never negative. The "type" field carries the sign.
- type must be exactly one of: ${types.join(", ")}.
  - "Expense" for a purchase or charge.
  - "Income" for money received that is not a dividend (salary, e-transfer received, etc).
  - "Transfer" for money moving between the household's own accounts (internal transfers, credit card payments FROM a chequing account, savings/investment contributions) - this is not real spending.
  - "Dividends" for investment dividend payments.
  - "Refund" for money back on an earlier purchase - a returned item, a cancelled booking, a partial credit. A Refund keeps the SAME category as the purchase it refunds (e.g. a refunded flight is still "Travel", not "Transfer") - never invent a "Refund" category.
- category should be the best match from this list: ${categories.join(", ")}. Only use a name outside this list if truly nothing fits.
- payment should be the best match from this list, or empty string if unclear: ${payments.join(", ") || "(none provided)"}.
- account should be the best match from this list, or empty string if unclear: ${accounts.join(", ") || "(none provided)"}.
- person should be the best match from this list if the statement or account ownership makes it clear, or empty string if not: ${people.join(", ") || "(none provided)"}.
- date must be YYYY-MM-DD. Infer the year from the statement's own header/period if a row only shows month/day.
- description is the merchant/payee text as it appears on the statement, cleaned up (drop reference numbers, keep the merchant name).
- recurring is true only if the statement itself marks it as recurring/pre-authorized, otherwise false.
- Skip subtotal, balance, and header/footer lines - only real individual transactions.
- If you are unsure of a field, leave it empty rather than guessing wildly, except amount/date/type/description which are required.`;

  const tool = {
    name: "extract_transactions",
    description: "Record every transaction found in the statement text.",
    input_schema: {
      type: "object",
      properties: {
        transactions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "YYYY-MM-DD" },
              type: { type: "string", enum: types },
              category: { type: "string" },
              subcategory: { type: "string" },
              description: { type: "string" },
              amount: { type: "number" },
              payment: { type: "string" },
              account: { type: "string" },
              person: { type: "string" },
              recurring: { type: "boolean" },
            },
            required: ["date", "type", "category", "description", "amount"],
          },
        },
      },
      required: ["transactions"],
    },
  };

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        tools: [tool],
        tool_choice: { type: "tool", name: "extract_transactions" },
        messages: [
          {
            role: "user",
            content: `Statement text:\n\n${text}`,
          },
        ],
      }),
    });
  } catch (e) {
    return json({ error: `Could not reach the Anthropic API: ${(e as Error).message}` }, 502);
  }

  if (!anthropicRes.ok) {
    const detail = await anthropicRes.text().catch(() => "");
    return json(
      { error: `Anthropic API error (${anthropicRes.status}): ${detail.slice(0, 500)}` },
      502,
    );
  }

  const result = await anthropicRes.json();
  const toolUse = (result.content || []).find(
    (c: { type: string }) => c.type === "tool_use",
  );
  const rows = toolUse?.input?.transactions;
  if (!Array.isArray(rows)) {
    return json({ error: "Claude did not return a transaction list. Try a smaller excerpt." }, 502);
  }

  return json({ rows, usage: result.usage });
});
