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