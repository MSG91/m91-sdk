# m91

**Wake a human when software cannot carry on alone.** An M91 alert rings every
phone in a channel at full volume — through silent mode and Do Not Disturb — and
keeps ringing until somebody answers. HIGH and CRITICAL alerts place a voice
call if 45 seconds pass in silence. Whoever takes the alert on is recorded, and
it clears for everyone else.

Email, SMS and chat arrive quietly and wait to be read. That is the right
behaviour for almost everything, and the wrong behaviour when somebody has to
act now.

```bash
npm install m91
```

Node 18+. **Zero dependencies** — native `fetch`, nothing else.

---

## Installation

The package itself needs nothing. The framework adapters use optional peer
dependencies, imported only when you call one:

| For | Install alongside |
|---|---|
| `m91` — client, platform, URL builder | nothing |
| `m91/integrations/langchain` | `@langchain/core` |
| `m91/integrations/langgraph` | nothing — it wraps the client, not the graph |
| `m91/integrations/vercel-ai` | `ai` |

---

## Quick start

You need a **send link** — `https://m91-api.msg91.com/s/<token>` — from the channel
in the M91 app. The token is in the URL path, so the link *is* the credential:
keep it in the environment, never in the repository.

```ts
import { M91Client } from 'm91';

const client = new M91Client(process.env.M91_SEND_LINK!);

await client.verify();                               // raises nothing; names the channel
await client.send('Database disk 90% full on node-7', {
  severity: 'HIGH',
  customId: 'disk-full-node7',                       // stable: the condition, not the moment
});
await client.close({ customId: 'disk-full-node7' }); // when the disk has been cleared
```

`verify()` is worth calling on startup. A mistyped link otherwise looks
perfectly healthy until the night it has to work.

---

## The approval gate

The reason an agent wants this: a question that blocks until a person answers on
their phone.

```ts
const approved = await client.requestApproval(
  'Agent wants to refund ₹48,000 on order ORD-40122',
  {
    description: 'Customer says it never arrived. Courier shows delivered, signed for.',
    customId: 'refund-ORD-40122',
    timeoutMs: 300_000,
  },
);

if (approved) await processRefund();
```

One call raises the alert, waits, and closes it afterwards. It resolves `true`
only when somebody tapped **Approve**. A rejection, a timeout and an unreachable
channel all resolve `false` or throw — there is no configuration under which
silence means yes.

### Asking for a reason, not just a tap

An option can require something before it can be chosen. `required` blocks the
button until it is supplied; `optional` offers a skippable field.

```ts
await client.send('Agent wants to refund ₹48,000 on order ORD-40122', {
  customId: 'refund-ORD-40122',
  responseOptions: [
    { label: 'Approve', effect: 'SHARED' },
    { label: 'Reject',  effect: 'SHARED', required: ['note'] },
    { label: 'Need the delivery photo', effect: 'SHARED', optional: ['attachment'] },
  ],
});
```

Only two things can be asked for: `'note'` and `'attachment'`. Requiring a note
on the rejection is the difference between your code learning *no* and learning
*why* — worth it on any branch that has to explain itself to a customer later.

Two more fields on `send`:

- **`attachments`** — https links to files the alert is about, shown on the
  alert screen. URLs, never bytes.
- **`other`** — whether the free-text "Something else" reply is offered. Leave
  it unset and the server's default (on) stands; set `false` when the answer
  must be one of your options.

### `callbackUrl` instead of polling

`waitForDecision` and `requestApproval` poll. For a service that is already
listening on a URL, hand M91 the URL instead and the outcome is POSTed to it
when somebody answers:

```ts
await client.send('Agent wants to refund ₹48,000 on order ORD-40122', {
  customId: 'refund-ORD-40122',
  callbackUrl: 'https://your-service.example.com/hooks/m91',
  responseOptions: [{ label: 'Approve', effect: 'SHARED' },
                    { label: 'Reject',  effect: 'SHARED', required: ['note'] }],
});
```

**It will not reach your laptop.** The callback is fetched by M91's servers and
private addresses are refused — `localhost`, `127.0.0.1`, `10.x`, `192.168.x`
and the rest — so local development and anything inside a VPC has to poll. Use
a tunnel, or keep `waitForDecision` for development and the callback in
production.

You still own the timeout either way. There is no server-side expiry: decide
what silence means before you send, and make it the safe answer.

---

## Severity

| | Delivery | Voice call |
|---|---|---|
| `LOW` | Rings through Do Not Disturb, repeats until answered | no |
| `MEDIUM` — the default | Rings through Do Not Disturb, repeats until answered | no |
| `HIGH` | The same | after 45s with no answer |
| `CRITICAL` | The same | after 45s with no answer |

MEDIUM is the default because HIGH dials phones, and "I didn't specify" must not
mean "ring everyone". `requestApproval` defaults to HIGH instead — something is
waiting on the answer, so a call after 45 seconds of silence is the point.

---

## Alert URLs

For anything whose only integration field is "URL to call": Grafana, Sentry,
UptimeRobot, Zapier, a GitHub Action, a cron `curl`, an iOS Shortcut, a browser
bookmark.

```ts
import { M91URLBuilder } from 'm91';

const builder = new M91URLBuilder(process.env.M91_SEND_LINK!);

console.log(builder.build('CPU above 95% on prod-server-3', {
  severity: 'HIGH',
  customId: 'cpu-high-prod3',
  respond: ['On it', 'Escalate'],
}));
// https://m91-api.msg91.com/s/TOKEN?title=CPU+above+95%25+on+prod-server-3&severity=HIGH
//   &customId=cpu-high-prod3&respond=On+it%2CEscalate
```

Paste that into Grafana's webhook field and it works — no client, no headers, no
code.

In `respond`, the **first label is SHARED** and the rest are PERSONAL. Up to six
in a link. To make a later one SHARED too, pass `{ label: 'Also on it' }`
instead of the bare string, or add a trailing `!`.

`builder.testUrl()` returns the bare link. Opening it **raises nothing** and
answers with the channel's name, which is also why a link preview, a crawler or
a mail scanner touching a pasted URL wakes nobody.

---

## Platform API — alerting one person

For a product that discovers its users at runtime, where a per-team send link
does not fit. Needs an API key (`m91sk_…`), minted from the app.

```ts
import { M91Platform } from 'm91';

const platform = new M91Platform(process.env.M91_API_KEY!);

await platform.verify();   // names the key and its owner. Alerts nobody.

// Idempotent — this belongs in your login handler, not a migration script.
// The label is your PRODUCT name: it is what she sees on the alert.
const recipient = await platform.inviteRecipient('919876543210', 'Acme CRM');

if (recipient.state === 'accepted') {
  await platform.alertPerson('919876543210', 'Your nightly export failed', {
    customId: 'export-fail-priya-2026-09',
  });
}
```

`label` is **what the person sees as the name of the thing alerting them** — your
product, not their name. It defaults to `"Direct alerts"`, and **every invite
overwrites it**, so pass the same constant on every login rather than letting a
later call reset it.

Only an **accepted** recipient can be woken. `pending` means they have been
asked and have not answered — nag them in your own UI rather than re-inviting in
a loop. `declined` is terminal: no API re-invites a declined number, and only
they can undo it.

An API key can also *provision* a team channel — `createChannel`, `addMembers`,
`removeMember` — but it **cannot alert one**. Alerting a team is always the send
link `createChannel` returns. A leaked key can restaff a channel; it cannot ring
a single phone in it.

`alertPerson` throws `M91DeliveryError` on a 2xx that reached nobody, same as
`send`. It matters more here: a direct alert has a roster of one, so a single
stale device token is the difference between waking somebody and waking nobody.

The cases an API key exists for — per-user alerting, per-tenant channels, roster
sync — and the much larger set where a send link is the right answer, are worked
through at **<https://m91-api.msg91.com/docs>**.

---

## LangChain

An agent that must not act alone needs a human, and the hard part is not pausing
— it is **reaching somebody**. `interrupt()` stops the graph and waits for a
resume that only arrives if a person happens to be watching a dashboard. M91
fills that half: the tool call rings every phone on a channel at full volume,
through silent mode and Do Not Disturb, escalating to a voice call if nobody
answers. The tool returns `"approved"` only when a human tapped **Approve**;
a rejection, a timeout and an unreachable channel are all a no.

```ts
import { M91Client } from 'm91';
import { createM91ApprovalTool, createM91AlertTool } from 'm91/integrations/langchain';

const client = new M91Client(process.env.M91_SEND_LINK!);

const tools = [
  await createM91ApprovalTool(client),  // blocks for a human
  await createM91AlertTool(client),     // wakes somebody, carries on
  ...myTools,
];
const agent = createReactAgent({ llm, tools, prompt: SYSTEM });
```

The factories are async because `@langchain/core` is imported only when you call
one — that is what keeps `npm install m91` at zero dependencies, which matters
for a package whose job is to work when everything else is on fire.

The tool descriptions tell the model when to reach for each one. Your system
prompt still has to say that approval is **required** before irreversible
actions, and to list them — see `examples/langchain-agent.ts`, included with the SDK.

`createM91ApprovalTool` returns a tool that answers `"approved"`, `"rejected"`
or `"error: …"`. Nothing but a real approval returns `"approved"`.

**Set the defaults where the tool is built, not in the prompt** — how long
somebody has to wake up is an operations decision, not the model's:

```ts
await createM91ApprovalTool(client, {
  severity: 'CRITICAL',
  approveLabel: 'Deploy',
  rejectLabel: 'Hold release',
  timeoutSeconds: 900,
});
```

---

## LangGraph

LangGraph knows how to stop a graph and resume it. What it has no opinion about
is how the human finds out it stopped. M91 is the part in between.

```ts
import { M91InterruptNotifier } from 'm91/integrations/langgraph';

const notifier = new M91InterruptNotifier(client, { timeoutMs: 600_000 });

let result = await graph.invoke(state, config);
if (result.__interrupt__) {
  const data = result.__interrupt__[0].value;
  const decision = await notifier.notify({ title: data.question, customId: data.customId });
  result = await graph.invoke(new Command({ resume: decision }), config);
}
```

Or let the graph own it:

```ts
import { createM91ApprovalNode } from 'm91/integrations/langgraph';

builder.addNode('approveRefund', createM91ApprovalNode(client, {
  approveLabel: 'Process Refund',
  rejectLabel: 'Hold Refund',
  timeoutMs: 600_000,
}));
```

The node reads `title` (or `question`) and `customId` from state, and writes
`{ decision, approved }` back for the next edge.

---

## Vercel AI SDK

```ts
import { createM91ApprovalTool, createM91AlertTool } from 'm91/integrations/vercel-ai';

const { text } = await generateText({
  model: openai('gpt-4o'),
  tools: {
    m91_request_approval: await createM91ApprovalTool(client),
    m91_send_alert: await createM91AlertTool(client),
  },
  stopWhen: stepCountIs(10),
  prompt: 'Verify the GDPR deletion request for acct_8821 and action it.',
});
```

---


## Error handling

Branch on `.code` — a stable string — never on `.message`, which is written for
a person and is expected to change.

```ts
import {
  M91AuthError, M91ChannelEmptyError, M91DeliveryError, M91Error,
  M91NetworkError, M91RateLimitError, M91ServerError, M91ValidationError,
} from 'm91';

try {
  await client.send('Payments API is down', { severity: 'CRITICAL', customId: 'payments-down' });
} catch (error) {
  if (error instanceof M91DeliveryError) {
    // 2xx, and nobody's phone rang. The one failure a status code hides.
    await pageBackupChannel({ unregistered: error.unregistered, noDevice: error.noDevice });
  } else if (error instanceof M91ChannelEmptyError) {
    log.error('M91 channel has no reachable members', error.unregistered);
  } else if (error instanceof M91RateLimitError) {
    // 60 sends a minute per link. Already retried once, at the server's own delay.
    log.warn(`M91 rate limited, retry after ${error.retryAfter}s`);
  } else if (error instanceof M91AuthError) {
    log.error('M91 send link is invalid or has been revoked');
  } else if (error instanceof M91ValidationError) {
    log.error(`M91 rejected the alert: ${error.message}`, error.details);
  } else if (error instanceof M91NetworkError || error instanceof M91ServerError) {
    log.error('M91 unreachable', error);
  } else if (error instanceof M91Error) {
    log.error(`M91 failed: [${error.code}] ${error.message}`);
  } else {
    throw error;
  }
}
```

| Thrown | When |
|---|---|
| `M91ValidationError` | a field breaks a limit, locally or at the server (400, 413) |
| `M91AuthError` | the credential is invalid, expired or revoked (401) |
| `M91ForbiddenError` | authenticated but not allowed (403) |
| `M91NotFoundError` | absent — or present and not yours (404) |
| `M91ChannelEmptyError` | nobody on the channel can receive (409) |
| `M91RateLimitError` | over 60 sends a minute on this link (429) |
| `M91ServerError` | M91's fault (5xx), after the retries are spent |
| `M91NetworkError` | the request never got an answer |
| `M91DeliveryError` | 2xx, and no phone was reached |
| `M91TimeoutError` | `throwOnTimeout: true` and nobody answered |

**Retries, which happen before any of these reach you:** a 429 is retried once,
after exactly the delay the server asked for. A 5xx is retried three times, at
1s, 2s and 4s. A 4xx is never retried — it is not transient. A network failure
is never retried either: a send that timed out may already have raised the
alert, and repeating it is how one condition wakes a team four times.

---

## The rules worth knowing

| | |
|---|---|
| **`customId` must be stable** | The same condition gets the same string every time — `disk-full-node7`, `refund-ORD-40122`. Built from a timestamp or a UUID it defeats deduplication (a check running every minute raises sixty alerts an hour) and leaves nothing stable to close by. |
| **`delivered` is not the roster** | It counts phones actually sent to. A channel of four whose device tokens are all stale answers 201 with `delivered: 0`. Assert on `alert.actuallyReachedSomeone`, not on the request succeeding. |
| **Read `decision`, never `responses[0]`** | Only a SHARED response sets `decision`. A PERSONAL one is an acknowledgement — reading it as an answer would let "Seen" mean "Approved". |
| **`isAutoClose` defaults to `false`** | The alert stays open until somebody closes it, even after a SHARED response claims it. Set it `true` when the first person taking it on really is the end of the matter. |
| **A bare send link raises nothing** | `GET /s/<token>` with no `title` is the connection test. That is what stops a link preview or a crawler waking a team, so it is a security boundary rather than a default. |
| **404 and 403 on `close()` are success** | Nothing left to close is the state you asked for. |
| **Never log the send link** | The token is in the path. The SDK redacts it in every string, error and tool result; do the same in your own logs. |
| **An API key cannot alert a team** | It provisions channels. Alerting one is the send link, always. |
| **Invite before you alert** | Alerting an uninvited number is a 404, never a silent invitation. Alerting somebody you *removed* is a 409 instead — their channel still exists, its roster does not. |
| **`delivered` is not an answer** | It means phones were sent to. Poll `decision` for what a human actually decided. |

---

## API reference

### `new M91Client(sendLink, options?)`

`options`: `{ timeoutMs?, throwOnZeroDelivery?, headers?, fetchImpl?, sleepImpl? }`

| Method | |
|---|---|
| `verify(): Promise<ChannelInfo>` | Check the link and name the channel. Raises no alert. |
| `send(title, options?): Promise<AlertResponse>` | Raise an alert. |
| `getAlert(customIdOrAlertId): Promise<AlertDetail \| null>` | Read one back, by either id. |
| `waitForDecision(customId, options?): Promise<Decision \| null>` | Block until a SHARED response claims it. |
| `close({ customId? , alertId? }): Promise<boolean>` | Close it. Exactly one id. |
| `requestApproval(title, options): Promise<boolean>` | Send, wait, close. |

`SendOptions`: `{ description?, severity?, customId?, isAutoClose?, responseOptions?, other?, attachments?, callbackUrl? }`
`WaitOptions`: `{ timeoutMs?, pollIntervalMs?, throwOnTimeout? }`
`ApprovalOptions`: `{ customId, description?, severity?, approveLabel?, rejectLabel?, timeoutMs?, pollIntervalMs?, timeoutMeansReject? }`

### `new M91Platform(apiKey, options?)`

| Method | |
|---|---|
| `verify(): Promise<ApiKeyInfo>` | Name the key and its owner. Alerts nobody. |
| `inviteRecipient(phone, label?): Promise<Recipient>` | Invite somebody. Idempotent. `label` is your product name. |
| `removeRecipient(phone): Promise<boolean>` | Stop alerting them. |
| `alertPerson(phone, title, options?): Promise<AlertResponse>` | Wake one person. |
| `getAlert(alertId, phone): Promise<AlertDetail \| null>` | Read what they decided. |
| `closeAlert(phone, { customId? , alertId? }): Promise<boolean>` | Close their alert. |
| `listChannels(): Promise<ProvisionedChannel[]>` | Every channel this key owns. |
| `createChannel(name, alertOwner?): Promise<ProvisionedChannel>` | **Not idempotent.** Store the result. |
| `addMembers(channelId, phones): Promise<InviteResult>` | Up to 500 per call. |
| `removeMember(channelId, phone): Promise<boolean>` | Take them off the roster. |

### `new M91URLBuilder(sendLink)`

| Method | |
|---|---|
| `build(title, options?): string` | One alert URL. |
| `buildMany(alerts): string[]` | One per spec. |
| `testUrl(): string` | The bare link. Raises nothing. |

### Types

`Severity` · `Effect` · `AlertStatus` · `RecipientState` · `ResponseOption` ·
`Collectable` · `Attachment` · `Decision` · `AlertResponse` · `AlertDetail` · `ChannelInfo` · `Recipient` ·
`ProvisionedChannel` · `InviteResult` · `ApiKeyInfo`

Helpers: `isApproved(decision, approveLabel?)` · `validatePhone(phone)` ·
`redact(url)` · `buildAlertPayload(title, fields?)`

---

## Running the tests

```bash
npm test
```

Compiles with `tsc` and runs the suite on Node's built-in test runner — no test
framework to install. Every test swaps `fetch`; nothing here makes a network
call, and nothing wakes anybody.

For the SDK against a real socket — a real send, a real poll loop, a real
timeout — point an example at your own channel. This wakes a phone:

```bash
export M91_SEND_LINK='https://m91-api.msg91.com/s/<token>'
npx tsx examples/basic-alert.ts
```

---

## Examples

The `examples/` directory included with the SDK covers a basic alert, the approval
gate, a LangChain agent, the LangGraph `interrupt()` pattern, a Vercel AI SDK
agent, and webhook URLs for Grafana and friends.

Full API documentation: **<https://m91-api.msg91.com/docs>**
