/**
 * The approval gate: ask a human, on their phone, and wait.
 *
 * This is the shape of every human-in-the-loop decision — raise the question,
 * block, act on the answer. One call does all of it, including closing the
 * alert afterwards so nobody is left with a live question that has been
 * answered.
 */

import { M91Client } from 'm91';

const client = new M91Client(process.env.M91_SEND_LINK!);

const approved = await client.requestApproval(
  'Agent wants to process a refund of ₹48,000 for order ORD-40122',
  {
    description:
      'Customer says the item never arrived. The courier\'s tracking shows delivered, ' +
      "signed for by 'R. Kumar'. The customer's name is Rahul Kumar. " +
      'Approving pays out immediately and cannot be reversed.',
    customId: 'refund-ORD-40122', // stable: the order id, never a timestamp
    severity: 'HIGH',
    approveLabel: 'Refund',
    rejectLabel: 'Hold',
    timeoutMs: 300_000,
  },
);

if (approved) {
  console.log('A human approved it. Processing the refund.');
} else {
  // Rejected, or nobody answered in five minutes. Both mean: do not pay out.
  // There is no configuration that makes silence mean yes.
  console.log('Not approved. Leaving the refund for the morning queue.');
}
