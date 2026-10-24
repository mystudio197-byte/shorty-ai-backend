# Shorty backend development review

Production Render service: `srv-dbd8lj4s728c73b1ap1g`.
Verified source: `mystudio197-byte/shorty-ai-backend`, branch `main`.
Render uses `npm install` then `npm start`; production was not changed.

## Configuration prepared; do not apply until deployment is approved

Copy the non-secret values from `.env.example` to Render Environment settings. The actual app secret must be entered directly by the owner in Render, never chat, GitHub, or frontend code. Saving Environment changes can redeploy Render; obtain deployment approval first. This server uses environment variables; `.env` files are not loaded automatically.

Meta App ID: `1397630030096694`. Add the backend callback exactly as the Valid OAuth Redirect URI:
`https://shorty-ai-backend.onrender.com/auth/facebook/callback`

Meta App Domains: `mystudio197-byte.github.io`, `shorty-ai-backend.onrender.com`.
Website platform URL: `https://mystudio197-byte.github.io/Shorty-AI-Downloader/`.
Privacy URL: `https://mystudio197-byte.github.io/Shorty-AI-Downloader/privacy.html`.
Data deletion instructions URL: `https://mystudio197-byte.github.io/Shorty-AI-Downloader/data-deletion.html`.
These pages only exist in the development checkout until publishing is approved. Do not submit unpublished URLs for review.

Use `pages_show_list` and `pages_read_engagement`. The Meta app is unpublished; use an authorized app administrator/tester for initial tests. Public customer access requires Meta's applicable review and access requirements. If Facebook Login for Business requires a configuration, create a minimal configuration for these two permissions and set `FACEBOOK_CONFIG_ID`. Do not enable publishing or messaging permissions.

## Security and behavior

- OAuth state is random, short-lived, single-use, and tied to an HttpOnly cookie.
- Meta user and Page tokens are kept in process memory only. They are never returned by the API.
- An opaque random Shorty bearer session key is delivered to the exact frontend origin by the OAuth popup. It is held in frontend memory only and expires after at most an hour.
- Only exact frontend Origin requests are accepted for authenticated API data. CORS is not authentication; the server also validates the Shorty session key.
- Every Page request refreshes the user's authorized Pages. Media imports also check the video's `from.id` matches the selected Page.
- Graph requests use Bearer authorization and `appsecret_proof`; paging source URLs are never returned.
- Media is streamed only from Graph-returned HTTPS `*.fbcdn.net` sources; redirects are revalidated and DNS resolves through existing public-address checks. Size limits apply.
- No arbitrary Facebook post scraping, personal-profile video import, or public Reel downloader.
- Sessions do not survive a restart or multiple backend replicas. A persistent encrypted token store and shared rate limiter are future production scaling work.
- Existing direct MP4 download host allowlist remains unchanged.
- Disconnect ends this backend session, not the Meta integration grant. Users can revoke the grant in Facebook settings.

## Tests

`npm test` uses mock Meta responses, never real credentials. Covers state, Page permissions, safe outputs, unauthorized Page access, ownership checks, media host checks, disconnect, and expiry.

## Release order after explicit approval

1. Review and merge backend changes; configure secrets directly in Render and deploy the backend.
2. Set exact Meta URLs and, if necessary, the Login for Business configuration.
3. Approve and publish the frontend, then connect Facebook and import an owned Page video end to end.
4. Verify disconnect, denied permissions, expired sessions, and local trim/export.
5. Keep the backups for rollback. Do not change plans or add paid resources.


## Checkpoint — 2026-10-24: token-exchange transport fix prepared

Verified staging is live at `93691f2`; production and `main` were not modified. The Meta developer dashboard for App ID `1397630030096694` is named Shorty AI Downloader. Its staging redirect is registered and the Meta URI validator accepts `https://shorty-ai-staging-api.onrender.com/auth/facebook/callback`. Live authorization requests use that App ID, callback, `v26.0`, and only `pages_show_list,pages_read_engagement`. The app remains unpublished.

Fresh OAuth returned Meta code 1 with client-secret-related guidance before permissions could be checked. This does not establish a secret mismatch. No real credentials were revealed, copied, logged, or changed. Current Meta manual-login documentation specifies GET for code exchange; this checkpoint changes the server's form POST to a server-only GET. Sensitive exchange URLs are never logged or returned, and provider errors remain sanitized.

Validation: all 13 mocked backend tests pass, including new GET-contract/callback matching and provider-error redaction tests. These are local tests, not successful live Facebook authorization. This fix is not yet pushed or deployed: GitHub writes require authentication. Existing draft PR: https://github.com/mystudio197-byte/shorty-ai-backend/pull/1 . Its earlier status text is stale and must be updated after publishing this checkpoint.

Next: publish development changes, update draft PR, deploy only the exact reviewed staging commit, verify health and retry OAuth. If code 1 persists, require the owner to compare secrets privately; do not guess or reset Meta credentials. Page content tests require explicit approved Page and test-video identities, still unavailable. No paid resources, production configuration, main merges or Facebook publications are authorized.
