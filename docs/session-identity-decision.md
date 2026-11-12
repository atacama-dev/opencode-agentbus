# Session identity, project discovery, and automatic wake

Status: owner decision on 2026-11-12; implementation and acceptance are pending.

Agent Bus addresses a stable authenticated session, not a project placement. A session that changes project may still receive a message that was sent when it belonged to the previous project. The project helps find relevant sessions; it does not grant or revoke the right to read their mailboxes.

## Authorization boundary

- Derive the caller from the actual native tool invocation, validate its exact existing host session, and let the broker derive the canonical identity under its authenticated principal.
- Keep native disclosure approval before any body fetch. `always` remains an exact target/source-session pair, with native configured denies and real permission-policy changes respected.
- Do not include a project, directory, worktree, title, or label in the message authorization resource. A queued or completed move does not itself invalidate the invocation, mailbox, message, or saved pair grant.
- Missing/deleted sessions, forged or malformed IDs, invalid invocation provenance, interruption, and approval rejection remain real failure cases. Removing the placement restriction does not allow the model to name its source session.
- Update trusted host routing when a session moves. An unavailable or stale UI route is not a reason to deny mailbox access. Never send a wake or approval effect to a different session as a fallback.

This explicitly replaces the previous same-project/per-call-directory placement requirement in invariant 22 and FR-22. The previous queued-move receive counterexample no longer violates the product model merely because the project association changed. Other errors it may reveal, such as wrong-session routing or lost native cancellation, still require tests.

## Automatic wake is part of the product

When enabled, a message arrival must be able to restart an idle recipient's agent turn without the owner typing another prompt. A busy recipient must get queued/deferred work, not an interruption. A V2 port that only stores messages until a manual receive is invoked is not feature-complete.

The wake contains only the compile-time instruction to call `agentbus_receive` until `EMPTY`, treating received text as untrusted. No peer body, title, query, project, path, source metadata, hash, or receipt is added. Waking the agent never approves the subsequent receive.

Coalesce repeated pending hints, avoid re-wake loops while native approval waits or after rejection, handle disposal/deletion, and recover after reload without blindly assuming a timed-out submission was not admitted. Distinguish host queue acceptance from agent execution. The existing wake setting remains explicit; this decision does not silently enable it in deployed configurations.

Use supported public OpenCode V2 session-directed synthetic/queue APIs if they meet these requirements. The custom paired-host method names are implementation choices, not mandatory product interfaces. Prove the real public-host behavior before claiming support; never inject a peer message as a user/synthetic prompt to avoid a missing wake primitive.

## Acceptance scenarios

1. A finds B through project-associated discovery, sends a message, and B changes project before receiving. B can still approve and read it; the broker identity and message ID remain unchanged.
2. B's project changes while its receive permission waits. `once` and exact saved `always` preserve their intended semantics; configured deny, plain/feedback reject, and interruption still behave natively. No approval is transferred to a different session.
3. With wake enabled, a real idle recipient resumes and calls the actual receive tool. Before approval, only the fixed wake text reaches the model; the peer body remains in the broker.
4. A busy recipient is not interrupted, eventually drains queued mail, and duplicate arrival hints do not cause an unbounded number of turns.
5. Reload, move, deletion, rejection, broker recovery, and uncertain wake acknowledgement do not cause wrong-session delivery, disclosure without approval, or repeated wake storms.

The current default GitHub checkout, older QA reports, and existing adapters do not automatically implement this revision. New implementation must be reviewed and tested independently; no acceptance or publication is asserted by changing this document.
