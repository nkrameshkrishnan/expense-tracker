/* AI-assisted transformation of raw statement text (from a PDF, or messy
   pasted/CSV text) into rows shaped for the staged-import review table in
   pages/data.js. The actual model call happens server-side, in the
   "import-transform" Supabase Edge Function - this module just gathers the
   household's current category/payment/account/person/type lists to send
   as context, calls the function, and runs whatever comes back through the
   same normalise() every other row in the app goes through before it's
   trusted (never render/store a field straight from the model untouched). */
import { TYPES, normalise } from "./store.js";
import { listFor } from "./categories.js";
import { state } from "./core.js";

/** True only for the Supabase backend - LocalStore/MemoryStore have no
    server to hold an Anthropic key, so this feature simply doesn't exist
    for them. Callers check this before offering the AI path in the UI. */
export function aiImportAvailable() {
  return state.store?.kind === "supabase";
}

/** Sends extracted statement text to the import-transform Edge Function and
    returns an array of rows ready for the review table (already normalised
    - not yet written anywhere). Throws with a user-facing message on any
    failure, same contract as importFile() in xlsxio.js. */
export async function transformWithAI(text) {
  if (!aiImportAvailable())
    throw new Error(
      "AI import needs the Supabase backend - it isn't available in local/offline mode.",
    );
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("No text was extracted to transform.");

  const { rows } = await state.store.callFunction("import-transform", {
    text: trimmed,
    categories: listFor("category"),
    payments: listFor("payment"),
    accounts: listFor("account"),
    people: listFor("person"),
    types: TYPES,
  });
  if (!Array.isArray(rows) || !rows.length)
    throw new Error("No transactions were found in that file.");
  return rows.map(normalise);
}
