# Memory conversation state — incomplete

This increment adds private session state and a built-in transcript view. It does not enable conversational memory approval. The terminal-input route and private memory-decision consumer are not connected yet. No memory slash command or separate review mode is added.

## Tool access

`getMemoryConversation(ctx)` returns a frozen facade for a tool context that the session owns. A copied context, a caller-supplied facade, or a `mode` or `approved` field does not grant access. A runner outside the session binding has no facade.

- `present(proposal)` returns an immutable copy of the exact proposal only after the native view confirms installation. Otherwise it returns `undefined`.
- `resolveReply(proposalId)` returns the original and submitted reply text once. It requires the same tool owner and proposal, an active input message, and a proposal that remains installed. It consumes the reply before returning.

The facade does not return an approval flag or execute a memory write. The memory consumer must still match the exact native proposal, interpret the original reply, and enforce the native decision rules.

## Limits of this increment

The interactive host binds the view through its native runner. It installs the complete, immutable proposal as literal text in the normal transcript and requires a native render pass before confirming installation. Native formatting can wrap lines and expand tabs; the stored proposal is unchanged. A custom or detached editor, an editor or custom-dialog transition, a dialog, an overlay, a stopped or failed render, or a replaced session, runner, renderer, or transcript cannot confirm the proposal. Terminal control codes and blank proposals are rejected rather than silently changing the displayed proposal.

A renderer stop or restart permanently retires the old renderer capture, even if the same renderer resumes. While the interactive host remains bound, a fresh tool context can bind the current native view after a restart or context reset. It cannot revive an earlier facade or reply. Unbinding the interactive host removes its registry rebuild callback. Revoking the runner removes the registry entry.

A facade alone cannot authorize a write. The input and decision connections remain incomplete. Synthetic state tests do not prove that the live terminal displayed a proposal or received a reply.

Session shutdown, reload, disposal, context refresh, compaction, and tree navigation revoke saved state. The remaining input integration must preserve original input through transforms and queues and reject restored or replaced contexts. The decision consumer must verify the complete native proposal before interpreting the reply.

The display check establishes that the complete proposal was installed in the owned transcript. It cannot prove that the user read it or establish human identity. This work does not contain arbitrary malicious JavaScript in the same process.
