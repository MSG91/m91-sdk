# Changelog

## 1.1.1

Metadata only — no code change.

`homepage` pointed at `https://m91.msg91.com`, which does not resolve: that
host is the static site, and every backend route lives on `m91-api.msg91.com`.
npm renders `homepage` as a link on the package page and freezes it per
version, so 1.1.0's link is dead for the life of that version. It now points at
the documentation.

The package also went out as `@msg91comm/m91` while the repository still said
`"name": "m91"`, so the next publish would have gone to a different package.
The repository now matches what is published.


## 1.1.0

Three gaps where the server had grown a field and the SDK had not, so the only
route to a value you had explicitly asked for was the raw body.

**Nothing breaks.** `AlertDetail.responses` holds typed objects now, and they
still answer to `r["label"]` and `r.get("note")` — the spelling callers already
use — so upgrading changes nothing you have written. (Python; in Node they were
`unknown[]`, which required a cast either way.)

### Added

- `send({ attachments: [...] })` — https links to files the alert is about. URLs,
  never bytes, because every automation a send link is pasted into has a URL
  field and little else. Validated locally so a typo costs no round trip.
- `send({ callbackUrl: ... })` — where the outcome is POSTed when somebody answers.
- `Response.note` and `Response.attachments`, the two things a sender can
  require before an option may be chosen.
- `AlertDetail.attachments` and `AlertDetail.pending`.
- `Attachment` and `Response` types.
- `M91Platform.listChannels()` — the
  missing half of the non-idempotent `create_channel`. A platform that lost the
  response to a create had an orphaned channel and no way to find it.


## 1.0.0

First release.

- `M91Client` — verify, send, getAlert, waitForDecision, close, requestApproval,
  against a channel send link.
- `M91Platform` — verify the key, invite and alert one person by phone number,
  and provision team channels, with an API key.
- `M91URLBuilder` — the GET form, for anything whose only field is "URL to call".
- Integrations: LangChain, LangGraph and the Vercel AI SDK.

Zero runtime dependencies: native `fetch`, Node 18+. Every framework adapter
imports its framework lazily, so installing this package pulls in none of them.

Four behaviours worth calling out, because they are the ones that differ from
what a hand-rolled wrapper around `fetch` usually does:

- **A send that reaches nobody throws `M91DeliveryError`.** `delivered` counts
  phones actually sent to, not the size of the roster, so a channel whose device
  tokens are all stale answers 201 and wakes nobody. This applies to
  `alertPerson` as well as `send`, and matters more there: a direct alert has a
  roster of one. Pass `{ throwOnZeroDelivery: false }` to opt out.
- **`close()` treats 404 and 403 as success.** Nothing left to close is the
  state the caller asked for.
- **`waitForDecision()` reads `decision` only.** A PERSONAL response ("Seen")
  never ends the wait, because "Seen" must never read as "Approved".
- **`verify()` on both clients tests a credential without waking anybody.**
  `M91Client.verify()` pings the send link; `M91Platform.verify()` calls
  `GET /api/v1/me` and names the key and its owner.
- **The send token is redacted from every string the SDK produces** — `toString`,
  error messages and tool results — including text written by the runtime, which
  can name the URL a request failed on.
