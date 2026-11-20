import type { McpToolDef } from "./mcp-client";
import type { ToolSource } from "./tool-types";

/**
 * Subagent-to-subagent messaging, now implemented as a plain in-memory
 * registry inside the app itself rather than a separate Rust/Axum MCP
 * server. That server existed only because LM Studio needed an MCP
 * `server_url` to call — now that the app dispatches every tool call
 * directly, the mailbox is just another local function.
 *
 * State is intentionally module-level (not React state) since it's pure
 * message-passing infrastructure with no rendering needs of its own; the
 * research loop still surfaces "message sent" / "message delivered" outcomes
 * via the same synthetic tool_call.* SSE events every other tool produces.
 */

const messages = new Map<string, string[]>();
const activeAgents = new Set<string>();
// Every key registered in the CURRENT cycle, active or already finished.
// Distinct from `messages.keys()`, which accumulates across the whole run
// (every cycle since the last resetMailbox()) and therefore includes agents
// from prior cycles that are no longer relevant. `knownAgents` is what
// broadcast_to_peers should fan out to; `messages.keys()` should not be used
// as a recipient set.
const knownAgents = new Set<string>();

export function registerAgent(key: string) {
  activeAgents.add(key);
  knownAgents.add(key);
}

export function deregisterAgent(key: string) {
  activeAgents.delete(key);
  // knownAgents intentionally keeps the key — a finished agent can still
  // receive a broadcast, and that note is preserved for final synthesis.
}

/** Call at the start of each new cycle, after prior-cycle agents have all
 * finished and their reports been collected. Clears the "known this cycle"
 * set so broadcasts stop fanning out to long-finished agents from earlier
 * cycles, without touching messages still queued for delivery. */
export function resetCycleAgents() {
  knownAgents.clear();
  activeAgents.clear();
}

/**
 * Notes folded into the compile prompt by the last collectUndelivered() call.
 * Kept so a RETRIED compile sees the same notes again (the inboxes have been
 * consumed), while a second compile can't re-fold them a second time.
 */
let collectedNotes: string[] = [];

export function resetMailbox() {
  messages.clear();
  activeAgents.clear();
  knownAgents.clear();
  collectedNotes = [];
}

const TOOL_DEFS: McpToolDef[] = [
  {
    name: "send_to_subagent",
    description: "Send a message to one specific peer by their internal key. Use it to share findings, flag a contradiction, or ask a question — even a one-line pointer to a source is worth sending. Messages to peers who have already finished are still preserved and folded into the final synthesis.",
    inputSchema: {
      type: "object",
      properties: {
        to_subagent_key: { type: "string", description: "Recipient subagent's internal key, as given to you in your instructions" },
        message: { type: "string", description: "Message content" },
      },
      required: ["to_subagent_key", "message"],
    },
  },
  {
    name: "check_inbox",
    description: "Check for incoming messages from other subagents addressed to you. Non-destructive: calling this does not consume anything — unread messages will also be delivered automatically at the start of your next turn, so seeing one here and again then is expected. You don't need to call this defensively.",
    inputSchema: {
      type: "object",
      properties: {
        my_subagent_key: { type: "string", description: "Your own internal key" },
      },
      required: ["my_subagent_key"],
    },
  },
  {
    name: "broadcast_to_peers",
    description: "Send a message to ALL other subagents in this cycle at once (a general update or a request for help). Use this whenever a finding is relevant to more than one peer, or when you're not sure which single agent should receive it -- it's easier and more reliable than guessing a peer's key. Messages are delivered to peers still researching (they see it on their next turn) and recorded for peers who have already finished (folded into the final synthesis).",
    inputSchema: {
      type: "object",
      properties: {
        my_subagent_key: { type: "string", description: "Your own internal key" },
        message: { type: "string", description: "Message content" },
      },
      required: ["my_subagent_key", "message"],
    },
  },
];

function callMailboxTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "send_to_subagent": {
      const to = String(args.to_subagent_key ?? "");
      const content = String(args.message ?? "");
      if (!to || !content) return "[error] to_subagent_key and message are both required.";

      // Always queue the note, even if the recipient has already finished this
      // cycle. A message to a still-active peer is drained and surfaced to
      // them on their next turn (tool-loop.ts auto-injects via drainInbox
      // before every turn); a message to a finished peer just sits in their
      // inbox — since nothing will ever drain a finished agent's inbox again,
      // it's collectUndelivered() at compile time that picks it up and folds
      // it into the final synthesized report. Rejecting delivery outright
      // would discourage cross-agent coordination, since agents finish at
      // different times and most sends would otherwise hit a "no longer
      // active" peer and be silently dropped.
      const inbox = messages.get(to) ?? [];
      inbox.push(content);
      messages.set(to, inbox);

      if (activeAgents.has(to)) {
        return `Message delivered to subagent '${to}'. They will see it on their next turn.`;
      }
      return `Message recorded for subagent '${to}' (already finished this cycle). Your note is preserved and will be incorporated into the final synthesized report even though '${to}' won't reply directly.`;
    }
    case "broadcast_to_peers": {
      const me = String(args.my_subagent_key ?? "");
      const content = String(args.message ?? "");
      if (!content) return "[error] message is required.";

      // Deliver to every peer registered THIS CYCLE except the sender —
      // still-active agents and ones that already finished this cycle both
      // count (their notes are preserved and folded into final synthesis).
      // Deliberately NOT messages.keys(): that map accumulates keys across
      // every cycle since the last resetMailbox(), so it would keep fanning
      // broadcasts out to agents from prior cycles that finished and were
      // already compiled long ago.
      let delivered = 0;
      for (const key of knownAgents) {
        if (key === me) continue;
        const inbox = messages.get(key) ?? [];
        inbox.push(content);
        messages.set(key, inbox);
        delivered++;
      }
      if (delivered === 0) {
        return "Broadcast sent, but there are no other peers in this cycle to receive it.";
      }
      return `Broadcast delivered to ${delivered} peer(s) (active and recently-finished, this cycle only). They will see it on their next turn, or it will be incorporated into the final synthesized report.`;
    }
    case "check_inbox": {
      // Non-destructive by design, matching the tool description: the
      // auto-inject in the tool loop (drainInbox, called once per turn) is
      // the actual point of consumption, and it also records everything into
      // peerMessages for the UI. A model-initiated check_inbox call is a
      // convenience read so the model can act on messages mid-turn without
      // waiting for the next auto-inject; it must not silently swallow
      // messages the auto-inject or a later check_inbox call still needs to
      // see, and it must not race with drainInbox over who "gets" a message.
      const me = String(args.my_subagent_key ?? "");
      const inbox = peekInbox(me);
      return inbox.length === 0 ? "No new messages." : inbox.join("\n---\n");
    }
    default:
      return `[error] Unknown mailbox tool "${name}".`;
  }
}

export function mailboxToolSource(): ToolSource {
  return {
    label: "mailbox",
    listTools: async () => TOOL_DEFS,
    callTool: async (name: string, args: Record<string, unknown>) => callMailboxTool(name, args),
  };
}

/**
 * Returns the unread messages across every agent's inbox, folded for the
 * compile prompt, and CONSUMES them. Consumption + a retained snapshot makes
 * the call idempotent: a retried compile sees the same notes, but a second
 * compile never re-folds the same message twice (previously the inboxes were
 * left intact, so every compile re-surfaced notes already folded — and keys
 * with emptied inboxes accumulated forever).
 */
export function collectUndelivered(): string[] {
  for (const [key, inbox] of messages) {
    if (inbox.length > 0) {
      collectedNotes.push(`--- Messages for ${key} ---\n${inbox.join("\n---\n")}`);
    }
    // Nothing pending for this key (drained, consumed, or never used) — drop
    // the entry so long runs don't accumulate stale inboxes. A later send
    // recreates it; peek/drain on a missing key already return empty.
    messages.delete(key);
  }
  return [...collectedNotes];
}

/** Returns unread messages for a single agent without clearing the inbox. */
export function peekInbox(agentKey: string): string[] {
  return messages.get(agentKey) ?? [];
}

/** Returns and clears unread messages for a single agent. */
export function drainInbox(agentKey: string): string[] {
  const inbox = messages.get(agentKey) ?? [];
  messages.set(agentKey, []);
  return inbox;
}