/* Overwritten at deploy time by .github/workflows/deploy.yml from repository secrets.
   The committed version is intentionally blank so the repo carries no endpoint.

   WARNING: whatever lands here IS SERVED TO EVERY VISITOR. GitHub Secrets keep
   values out of your repository, not out of your published JavaScript. If you would
   mind a stranger reading and writing your sheet, leave these blank and enter the
   endpoint at runtime under Data → Google Sheet, which stores it only in your browser. */
export const SHEETS_ENDPOINT = "";
export const SHEETS_TOKEN = "";
export const BUILD_STAMP = "dev";

/* Google OAuth client ID. Public by design - it identifies the app, it does not
   authorise anything. Access is decided in Apps Script by verifying the signed
   ID token and checking the email against ALLOWED_EMAILS there. */
export const GOOGLE_CLIENT_ID = "";

/* Supabase project - the planned replacement for the Sheets/Apps Script backend.
   SUPABASE_URL and the anon key are both meant to be public (same as
   GOOGLE_CLIENT_ID above): access is decided by Row Level Security policies on
   the database itself, verifying the same Google ID token's email against an
   allow-list - the anon key alone grants nothing without a valid signed-in
   session. Leave blank to keep using the Sheets backend; store.js prefers
   Supabase over Sheets only once both are actually configured. */
export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";
