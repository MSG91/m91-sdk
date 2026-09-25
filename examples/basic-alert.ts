/**
 * Raise an alert, then close it when the condition heals.
 *
 *   export M91_SEND_LINK="https://m91.msg91.com/s/your_token"
 *   npx tsx examples/basic-alert.ts
 *
 * The send link is the whole credential. It goes in the environment, never in
 * the repository — the token is in the URL path, so the URL *is* the password.
 */

import { M91Client, M91DeliveryError } from 'm91';

const client = new M91Client(process.env.M91_SEND_LINK!);

// Raises nothing. Worth doing on startup: a mistyped link otherwise looks fine
// until the night it has to work.
const channel = await client.verify();
console.log(`Connected to '${channel.name}' (${channel.visibility})`);

const alert = await client.send('Database disk 90% full on node-7', {
  description: '/var/lib/postgresql at 90%. Growing ~2GB/hour. ~5 hours left.',
  severity: 'HIGH', // HIGH also places a voice call after 45s of silence
  // Stable: the SAME string every time this condition is true. A check running
  // every minute then raises one alert, not sixty — and this is what closes it.
  customId: 'disk-full-node7',
  responseOptions: [
    { label: 'On it', effect: 'SHARED' }, // takes it on, clears for everyone
    { label: 'Seen', effect: 'PERSONAL' }, // acknowledges, stays with the team
  ],
});

// Not "did the request succeed" — `delivered` is phones actually reached.
console.log(`Delivered to ${alert.delivered} phones (alert ${alert.id})`);
if (alert.deduplicated) {
  console.log('An alert for this was already open — nobody was woken a second time.');
}

// ...later, when the disk has been cleared:
await client.close({ customId: 'disk-full-node7' });

// The failure worth catching by name: a 2xx where nobody's phone rang.
try {
  await client.send('Heartbeat check from the example', { customId: 'example-heartbeat' });
} catch (error) {
  if (error instanceof M91DeliveryError) {
    console.error(
      `Nobody was reachable: ${error.unregistered.length} unregistered, ` +
        `${error.noDevice} without a device`,
    );
  } else {
    throw error;
  }
}
