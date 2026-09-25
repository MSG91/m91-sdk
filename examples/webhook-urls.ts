/**
 * Alert URLs for tools whose only integration field is "URL to call".
 *
 * Grafana, Sentry, UptimeRobot, Zapier, a GitHub Action, a cron `curl`, an iOS
 * Shortcut, a browser bookmark, an `<img>` tag in a status page. No client, no
 * headers, no code — which is the point: this is the difference between M91
 * being wired into something this afternoon and being wired in never.
 */

import { M91URLBuilder } from 'm91';

const builder = new M91URLBuilder(process.env.M91_SEND_LINK!);

// Paste this into Grafana's webhook URL field.
console.log(
  builder.build('CPU above 95% on prod-server-3', {
    severity: 'HIGH',
    customId: 'cpu-high-prod3',
    // First label is SHARED — one person takes it on and it clears for the rest.
    // The others are PERSONAL: an acknowledgement that leaves it looking for an owner.
    respond: ['On it', 'Escalate'],
  }),
);

// The bare link. Opening it RAISES NOTHING and answers with the channel's name,
// so whoever is pasting it can see they picked the right team. That is also why
// a link preview, a crawler or a mail scanner touching the URL wakes nobody.
console.log(builder.testUrl());

// A batch, for generating a dashboard's worth at once.
for (const url of builder.buildMany([
  { title: 'Disk above 90% on prod-3', customId: 'disk-high-prod3', severity: 'MEDIUM' },
  { title: 'Certificate expires in 48 hours', customId: 'cert-expiry', severity: 'LOW' },
  { title: 'Payment gateway unreachable', customId: 'gateway-down', severity: 'CRITICAL' },
])) {
  console.log(url);
}

// In a crontab, where there is no Node at all:
//
//   0 9 * * * curl -fsS "https://m91.msg91.com/s/TOKEN?title=Daily+backup+did+not+run&severity=HIGH"
//
// The URL contains the token, so it is a credential. Keep it out of anything
// public, and out of anything that ends up in a screenshot.
