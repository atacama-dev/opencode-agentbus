# Manual attached-client QA

Use this opt-in procedure to verify real OpenCode wake, native approval, and UI routing across two attached workspaces without hardcoding an operator's installation.

This procedure targets the OpenCode 1.18.19-compatible API used by this repository, with session-status compatibility coverage for 1.18.23. It is not a claim of OpenCode V2 compatibility. The [QA evidence](qa.md) records which gates have actually run; this gate is still outstanding.

## Prepare a controlled server

This test sends live messages and may require restarting the selected OpenCode server. Use a dedicated test instance where possible. Do not restart an unrelated user service or stop the detached broker. Record the server configuration, process working directory, and service state before changing anything.

From the repository root, set installation-specific values in your control terminal:

```bash
AGENTBUS_REPO="$(pwd -P)"
OPENCODE="$(command -v opencode)"  # Or an absolute path to the intended binary.
WORKSPACE_A="$AGENTBUS_REPO"
WORKSPACE_B=/absolute/path/to/another/test-workspace
SERVER_URL=http://127.0.0.1:4096
EXPECTED_SERVER_CWD=/absolute/path/to/test-server-root
```

Replace every placeholder. Use distinct existing workspaces under the intended test server root, and start the server from that broader root rather than either attached workspace. Do not infer its working directory from a client terminal. Confirm the actual server process working directory matches `EXPECTED_SERVER_CWD` using your supervisor or, on Linux, `readlink "/proc/$SERVER_PID/cwd"` with the verified server PID.

Build the plugin:

```bash
(cd "$AGENTBUS_REPO" && bun run build)
```

Configure the selected server to load the built plugin at the absolute `file://` URL for `$AGENTBUS_REPO/packages/plugin/dist/index.js`. Use the intended credential file, set receive/search permissions to `ask`, enable `wakeOnMessage` and `focusOnReceiveApproval`, and disable auto-approval. Follow the [operator configuration](../README.md#configure-opencode) for this repository's locked API. Reload or restart only the selected test instance if required by that host version, then check its health and actual working directory again.

If you use systemd, keep the unit name, restart commands, and log commands in `.local/operator-notes.md`. The plugin does not require a particular service manager or unit name. Do not publish logs containing credentials, message bodies, or personal paths.

## Attach two clients

Set `OPENCODE`, `SERVER_URL`, and the appropriate workspace variable in each new terminal; shell variables from the control terminal are not automatically shared.

Client A:

```bash
"$OPENCODE" attach "$SERVER_URL" --dir "$WORKSPACE_A"
```

Client B:

```bash
"$OPENCODE" attach "$SERVER_URL" --dir "$WORKSPACE_B"
```

Use fresh sessions and make their generated titles distinguishable with the markers `LIVE-A-ROUTE-CHECK` and `LIVE-B-ROUTE-CHECK`. Ensure no other active session matches those markers. In client A, issue this instruction and approve only the native search prompt:

```text
Use agentbus_search_sessions to search for LIVE-B-ROUTE-CHECK. Use exactly the returned opaque sessionId as the target of agentbus_send with body "CBL-01 attached-workspace route sentinel from A". Do not use any filesystem path as a tool argument.
```

## Acceptance observations

1. A search approval is shown in client A, and the send completes there.
2. Only client B receives B's pending toast and fixed wake; no B-directed status, toast, wake, or focus effect appears in client A.
3. The fixed wake contains only the compile-time drain instruction. It contains neither the `CBL-01` body nor either workspace path or session title.
4. B's real `agentbus_receive` opens the native approval in/focused on B. Approve `once`; the sentinel appears only in B's explicitly untrusted tool result.
5. In B, issue `Call agentbus_reply with the delivered messageId and body "CBL-01 correlated reply from B".` The reply receipt has a fresh `messageId` and the original `replyToMessageId`.
6. Only client A receives A's pending toast/wake. Approve A's real receive once and verify the correlated reply is delivered once as untrusted tool output.
7. Send a fresh message to B, reject its native receive approval, and confirm no body disclosure, no automatic re-wake loop, and unchanged native permission status.
8. Keep one client busy during another delivery and confirm status/wake handling remains in the target workspace and resumes on its idle event.

## Record and restore

Check the selected server's health and logs without changing broker state. Record the OpenCode version, actual server working directory, client session IDs, pass/fail for each observation, and any host-visible path/body leak in `.local/`. Redact these details before sharing evidence. Restore the pre-test service/configuration state if it differed. Do not claim this gate from the simulated integration host.
