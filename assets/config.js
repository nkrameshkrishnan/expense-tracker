/* Overwritten at deploy time by .github/workflows/deploy.yml from repository secrets.
   The committed version is intentionally blank so the repo carries no endpoint/key. */
export const BUILD_STAMP = "dev";

/* Google OAuth client ID. Public by design - it identifies the app, it does not
   authorise anything. Access is decided by Supabase Row Level Security, which
   verifies the signed ID token and checks the email against an allow-list in
   the database (see supabase/schema.sql) - Google sign-in is the identity
   provider, not the access control. */
export const GOOGLE_CLIENT_ID = "";

/* Supabase project - the only real backend now (the earlier Google
   Sheets/Apps Script backend has been removed). SUPABASE_URL and the anon
   key are both meant to be public (same as GOOGLE_CLIENT_ID above): access is
   decided by Row Level Security policies on the database itself, verifying
   the same Google ID token's email against an allow-list - the anon key
   alone grants nothing without a valid signed-in session.

   WARNING: whatever lands here IS SERVED TO EVERY VISITOR. GitHub Secrets keep
   values out of your repository, not out of your published JavaScript. If you
   would mind a stranger reading the anon key, leave these blank and enter them
   at runtime instead (Data tab → stored in this browser's localStorage only,
   never published) - see README.md's "GitHub Secrets cannot keep a secret in
   a static site" for the full reasoning, and make sure supabase/schema.sql's
   RLS policies are applied before pointing this at a project with real data. */
export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";
