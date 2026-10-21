/**
 * LangGraph's `interrupt()` pattern, with M91 filling the gap.
 *
 * LangGraph knows how to stop a graph and resume it. What it has no opinion
 * about is how the human finds out it stopped — and the default answer is that
 * somebody notices a paused run in a web UI. At 2am, for a graph that paused
 * because it wants to move money, nobody does.
 *
 * M91 is the part between the pause and the resume.
 */

import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';

import { M91Client } from '@msg91comm/m91';
import { M91InterruptNotifier } from '@msg91comm/m91/integrations/langgraph';

const client = new M91Client(process.env.M91_SEND_LINK!);
const notifier = new M91InterruptNotifier(client, { severity: 'HIGH', timeoutMs: 600_000 });

const State = Annotation.Root({
  id: Annotation<string>,
  amount: Annotation<number>,
  result: Annotation<string>,
});

const builder = new StateGraph(State)
  .addNode('riskyAction', (state) => {
    if (state.amount > 10_000) {
      // The graph stops here and hands the payload out to the orchestrator.
      const decision = interrupt({
        question: `Approve payment of ₹${state.amount.toLocaleString()} on order ${state.id}?`,
        customId: `payment-${state.id}`,
      });
      if (decision !== 'approved') return { result: 'payment_rejected' };
    }
    // await executePayment(state);
    return { result: 'payment_completed' };
  })
  .addEdge(START, 'riskyAction')
  .addEdge('riskyAction', END);

const graph = builder.compile({ checkpointer: new MemorySaver() });
const config = { configurable: { thread_id: 'order-40122' } };

let result = await graph.invoke({ id: 'ORD-40122', amount: 48_000 }, config);

if (result.__interrupt__) {
  const data = result.__interrupt__[0].value as { question: string; customId: string };

  // A phone rings at full volume, through Do Not Disturb, until somebody
  // answers — and gets a voice call if 45 seconds pass in silence.
  const decision = await notifier.notify({
    title: data.question,
    customId: data.customId, // the graph chose it, and it is stable
  });

  result = await graph.invoke(new Command({ resume: decision }), config);
}

console.log(result.result);

// The same thing as a node, when you would rather the graph own it:
//
//   import { createM91ApprovalNode } from '@msg91comm/m91/integrations/langgraph';
//   builder.addNode('approveRefund', createM91ApprovalNode(client, {
//     approveLabel: 'Process Refund', rejectLabel: 'Hold Refund', timeoutMs: 600_000,
//   }));
//
// It reads `title`/`question` and `customId` from state, and writes
// { decision, approved } back for the next edge to branch on.
