/**
 * Framework adapters, re-exported.
 *
 * Each one imports its framework lazily, so `npm install @msg91comm/m91` pulls in none of
 * them and using one you have not installed says which package to install
 * rather than failing with a bare module-not-found from three frames down.
 *
 * Importing a specific adapter directly is usually better —
 * `@msg91comm/m91/integrations/langchain` — because it pulls in only what you use.
 *
 * Several adapters export `createM91ApprovalTool`, so
 * they are re-exported under namespaces rather than flattened: two functions of
 * the same name doing the same job for different frameworks is exactly the pair
 * that would silently resolve to the wrong one.
 */

export * as langchain from './langchain.js';
export * as langgraph from './langgraph.js';
export * as vercelAi from './vercel-ai.js';
export * as openaiAgents from './openai-agents.js';
export * as claudeAgentSdk from './claude-agent-sdk.js';
export * as googleAdk from './google-adk.js';
export * as mastra from './mastra.js';

export { M91InterruptNotifier, createM91ApprovalNode } from './langgraph.js';
export { APPROVED, REJECTED, alertResult, decideToolCall, errorResult } from './specs.js';
export type { AlertArgs, ApprovalArgs, GateDecision, GateOptions, GatedCall } from './specs.js';
