# Memory conversation state — incomplete

This increment connects private session state, the built-in transcript view, and native terminal reply transport. It does not enable conversational memory approval: the private memory-decision consumer and memory effects are not connected. No memory slash command or separate review mode is added.

## Tool access

`getMemoryConversation(ctx)` returns a frozen facade for a tool context that the session owns. A copied context, a caller-supplied facade, or a `mode` or `approved` field does not grant access. A runner outside the session binding has no facade.

- `present(proposal)` returns an immutable copy of the exact proposal only after the native view confirms installation. Otherwise it returns `undefined`.
- `resolveReply(proposalId)` returns the original and submitted reply text once. It requires the same tool owner and proposal, an active input message, and a proposal that remains installed. It consumes the reply before returning.

The facade does not return an approval flag or execute a memory write. The memory consumer must still match the exact native proposal, interpret the original reply, and enforce the native decision rules.

## Limits of this increment

The interactive host binds the view through its native runner. It installs the complete, immutable proposal as literal text in the normal transcript and requires a native render pass before confirming installation. Native formatting can wrap lines and expand tabs; the stored proposal is unchanged. A custom or detached editor, an editor or custom-dialog transition, a dialog, an overlay, a stopped or failed render, or a replaced session, runner, renderer, or transcript cannot confirm the proposal. Terminal control codes and blank proposals are rejected rather than silently changing the displayed proposal.

A renderer stop or restart permanently retires the old renderer capture, even if the same renderer resumes. While the interactive host remains bound, a fresh tool context can bind the current native view after a restart or context reset. It cannot revive an earlier facade or reply. Unbinding the interactive host removes its registry rebuild callback. Revoking the runner removes the registry entry.

## Native reply transport

The default editor captures the original terminal input before mutable submission callbacks. A constructor-owned submission scope carries that observation into the interactive host. Caller-supplied data flags and programmatic copies cannot substitute for the observation.

The host keeps original input separate from transformed model text. A private envelope carries it through startup, streaming, follow-up and compaction queues. The session associates the final user-message object by identity, then activates it before extension and queue observers. A copied options object, a copied message or a public queue preview cannot activate the original input. Public text retrieval and queue restoration discard the old observation; editing restored text requires a new native submission.

Run completion, failure, abort and queue clearing discard input state. Session shutdown, reload, disposal, context refresh, compaction and tree navigation revoke saved proposal state. A restored or replaced context cannot revive an old reply.

A facade and an original reply do not authorize a write. The decision consumer must still verify the complete native proposal and interpret the reply before any memory effect. That connection remains incomplete. Synthetic tests do not prove that the installed terminal displayed a proposal or received a reply.

The display check establishes that the complete proposal was installed in the owned transcript. It cannot prove that the user read it or establish human identity. This work does not contain arbitrary malicious JavaScript in the same process.
