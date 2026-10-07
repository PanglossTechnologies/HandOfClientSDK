# Python (Flask) host sample

About 70 lines. Shows the one backend piece a host needs: a same-origin `/hoc/token` endpoint that
identifies the signed-in user from your own session and mints an embed token with your host API key.

```
# build embed.global.js once: from the repo root, npm install && npm run build
mkdir -p static && cp ../../../sdk/embed-js/dist/embed.global.js static/
pip install -r requirements.txt
export HOC_API_BASE_URL=https://hocapi.panglosstechnologies.com
export HOC_HOST_ID=...  HOC_HOST_API_KEY=...  HOC_TENANT_ID=...
export FLASK_SECRET_KEY=$(python -c "import secrets;print(secrets.token_hex(32))")
export FLASK_DEBUG=1
flask --app app run
# visit /dev-login/alice, then /dashboard
```

Before production: replace `current_user()` with real auth, delete `/dev-login`, serve over HTTPS, and
keep `HOC_HOST_API_KEY` in your secret store. `embed.global.js` is served by your own app (`static/`); the platform does not host it.
