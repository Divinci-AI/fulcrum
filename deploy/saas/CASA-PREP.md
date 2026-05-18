# CASA submission prep checklist

CASA (Cloud Application Security Assessment) is Google's third-party
audit required for any OAuth app that uses **sensitive scopes** and
wants to graduate from "Testing" to "In production". Fulcrum uses
`calendar` and `gmail.modify` — both sensitive — so we're on the
testing-mode treadmill (100-user cap, 7-day refresh-token expiry)
until CASA passes.

**Lead time**: 2–6 months from kickoff to verification. **Cost**:
$500–$4,500/year, paid to one of Google's authorized assessors.

This file is the prep checklist — work it top-to-bottom before
engaging an assessor. None of it is code; all of it is operator
work.

---

## 1. Decide whether CASA is worth it right now

Skip CASA if all three are true:
- We have < 100 Google-OAuth users across all tenants
- Operators can stomach reconnecting Google every 7 days
- No outside-Divinci-AI users are reachable on the tenant (Divincians
  CF Access Group + Fulcrum admin invite are the gates)

Do CASA when any are true:
- A customer outside @divinci.{ai,app,net} starts using Gmail/Calendar
  integration regularly and complains about the 7-day reconnect
- We're approaching the 100-user testing-mode limit
- A sale is gated on "is this in Google's production OAuth status"

---

## 2. Identify the scopes that trigger CASA

```bash
grep -rn "scope.*calendar\|scope.*gmail\|googleapis.com/auth" \
    server/services/google-oauth.ts server/services/google/
```

Today Fulcrum requests:
- `https://www.googleapis.com/auth/calendar` — sensitive
- `https://www.googleapis.com/auth/gmail.modify` — sensitive
- `https://www.googleapis.com/auth/userinfo.email` — non-sensitive

CASA scope-by-scope; minimize before submitting. If we can drop
`gmail.modify` and use `gmail.readonly` instead (or `gmail.compose`
for drafts only), the assessment is cheaper. Audit which Gmail
calls actually mutate before locking the scope set.

---

## 3. Audit the OAuth client configuration

In Google Cloud Console → APIs & Services → OAuth consent screen for
the **Divinci-AI** project (NOT individual operator projects):

- [ ] **App name** matches what's deployed (e.g., "Fulcrum")
- [ ] **User support email** is a monitored mailbox
- [ ] **Developer contact** is a monitored mailbox
- [ ] **App logo** is uploaded (120×120 PNG, no transparency)
- [ ] **Authorized domains** include `divinci.ai` (and any other
  tenant domains)
- [ ] **Application home page** points at a public URL describing
  Fulcrum
- [ ] **Privacy policy URL** is published and reachable
- [ ] **Terms of service URL** is published and reachable
- [ ] **Authorized redirect URIs** include every prod redirect:
  `https://<slug>.fulcrum.divinci.ai/api/google/oauth/callback` per
  tenant
- [ ] **Authorized JavaScript origins** likewise

The privacy policy must explicitly call out:
- What data each scope reads/writes
- Where the data is stored (per-tenant container, encrypted at rest
  via SQLite + fnox)
- Retention policy
- How users can request deletion (account-management workflow)

If we don't have a published privacy policy and ToS, **fix that first**
— CASA won't proceed without them.

---

## 4. Security posture audit

CASA reviews:
- [ ] **TLS everywhere** — every redirect URI is HTTPS (we are; CF
  Access enforces TLS on the edge)
- [ ] **Token storage** — refresh tokens encrypted at rest. Fulcrum
  stores them via fnox age encryption in `~/.fulcrum/config/fnox.toml`.
  Document this for the assessor.
- [ ] **Token scope minimization** — we should request only the scopes
  we need (see #2)
- [ ] **Revocation flow** — users must be able to revoke. Fulcrum
  surfaces "Disconnect Google account" in Settings; verify it actually
  revokes the token via `https://oauth2.googleapis.com/revoke` (not
  just deletes the local row).
- [ ] **PII handling** — no raw scope data sent to third-party services
  (analytics, error tracking) without consent. Audit current logging
  for accidental PII leak in error messages.
- [ ] **Incident response plan** — written, includes contact email +
  expected response time

---

## 5. Pick an authorized assessor

Google publishes the list at
https://developers.google.com/cloud-security-program/casa/laboratories.
Get quotes from 2–3 before committing.

Common cost ranges:
- **Self-attest (Tier 1)** — $0, but only valid for ≤ 10K users + only
  certain scope categories. Fast path if eligible.
- **Tier 2 third-party** — $500–$2,500/yr typical
- **Tier 3 third-party deep audit** — $2,500–$4,500/yr typical

Self-attest is worth checking first; the form is at
https://services.google.com/fb/forms/casa-tier-1/.

---

## 6. Submit and iterate

Once an assessor is engaged:
- [ ] Provide our app's privacy policy + ToS links
- [ ] Provide the OAuth client ID + the list of scopes
- [ ] Walk through the auth flow with the assessor on a screenshare
- [ ] Be ready to ship security fixes within a 2-week window if they
  find issues (e.g., scope reduction, error-handling tightenings)

Once CASA passes:
- [ ] Move the OAuth client from "Testing" → "In production" in the
  Cloud Console
- [ ] Re-confirm token-refresh works past the 7-day boundary
- [ ] Update memory `fulcrum_google_oauth_pain.md` to reflect that
  the 7-day token rot is finally gone

---

## What this enables once done

- Unbounded users (no 100-user testing cap)
- Refresh tokens last as long as Google's standard rotation policy
  (months/years, not 7 days)
- Public-facing "Sign in with Google" works for any email outside
  the developer's allowlist
