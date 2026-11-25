# Switchboard

Multi-tenant shared team inbox built on Express, MongoDB, Redis, WebSockets (`ws`), and React (Vite + TypeScript).

## Running from a clean clone

1. Install dependencies:
   ```bash
   npm run scaffold:install
   ```
2. Start MongoDB, Redis, Pigeon, and the Mock IdP:
   ```bash
   npm run up
   ```
   *(Or `npm run mocks` if running without Docker, with `MONGO_URL` and `REDIS_URL` pointing to your instances.)*
3. Start the backend and frontend:
   ```bash
   npm run scaffold:server
   npm run scaffold:web
   ```
4. Open `http://localhost:5173` and sign in via the Mock IdP.

## Running tests & checks

- Unit / contract tests:
  ```bash
  npm --prefix scaffold/server test
  ```
- Typechecks & frontend build:
  ```bash
  npm --prefix scaffold/server run typecheck
  npm --prefix scaffold/web run typecheck
  npm --prefix scaffold/web run build
  ```
- Automated harness check (stop your own dev server first; run from Git Bash on Windows so `sh` is available):
  ```bash
  npm run check:full
  ```
