# Growebtek AI Stock & Fund Analyzer

Login-protected web app: India and US market reports, a stock analyzer (any country, local currency, comparison) and a mutual fund analyzer (Indian and global funds, comparison).

- Frontend: static files served by GitHub Pages.
- Backend: `backend/Code.gs`, a Google Apps Script web app (logins, user access list, live market data).
- Data: market prices, company data and news are fetched live; Indian mutual fund NAVs come from mfapi.in. US report data is refreshed by GitHub Actions.

## Backend setup (one time)
1. Open https://script.google.com and create a new project.
2. Paste the backend code (the copy with the admin hash filled in, shared privately with the owner — this public file only has placeholders).
3. Run `setupTest` once and allow the permissions.
4. Deploy → New deployment → Web app. Execute as: **Me**. Who has access: **Anyone**.
5. Put the `/exec` URL in `config.js` as `API_URL`.

The admin password is never stored anywhere. The backend keeps only a salted one-way hash, and the admin can change the password from the admin panel.

For information and education only. Not investment advice.
