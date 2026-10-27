# Memory conversation state — incomplete

This increment adds private session state. It does not enable conversational memory approval. The built-in transcript, terminal-input route, and private memory-decision consumer are not connected yet. No memory slash command or separate review mode is added.

## Tool access

`getMemoryConversation(ctx)` returns a frozen facade for a tool context that the session owns. A copied context, a caller-supplied facade, or a `mode` or `approved` field does not grant access. A runner outside the session binding has no facade.

- `present(proposal)` returns an immutable copy of the exact proposal only after the native view confirms installation. Otherwise it returns `undefined`.
- `resolveReply(proposalId)` returns the original and submitted reply text once. It requires the same tool owner and proposal, an active input message, and a proposal that remains installed. It consumes the reply before returning.

The facade does not return an approval flag or execute a memory write. The memory consumer must still match the exact native proposal, interpret the original reply, and enforce the native decision rules.

## Limits of this increment

There is no native view binding in this increment. A facade alone cannot present a proposal or authorize a write. Synthetic state tests do not prove that the live terminal displayed a proposal or received a reply.

Session shutdown, reload, disposal, context refresh, compaction, and tree navigation revoke saved state. The remaining integration must establish a fresh binding where needed. It must preserve original input through transforms and queues, reject restored or replaced contexts, and verify the complete proposal after rendering.

A future display check can establish that the complete proposal was installed in the owned transcript. It cannot prove that the user read it or establish human identity. This work does not contain arbitrary malicious JavaScript in the same process.
