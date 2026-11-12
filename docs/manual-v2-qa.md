# Manual public OpenCode V2 probes

These clients exercise a **dedicated disposable stock OpenCode 2.2.7 test server** with the experimental Agent Bus entry. They do not provision that server, install a package, or certify a release. Never point them at a shared server: they create sessions, submit prompts, answer native permission requests, move sessions, and delete a test session.

The automatic unit/integration suites do not run these drivers. Their names deliberately do not end in `.test.ts`.

## Provision the isolated experiment

Before either driver runs, prepare all of the following outside your normal OpenCode configuration and state:

- The pinned official OpenCode binary, separate HOME/config/state and unused loopback ports. Do not inherit real provider credentials or production data.
- A test-only local plugin wrapper selecting the built `@opencode-agentbus/plugin/stock-experimental` entry, with `experimentalStock: true`, explicit independent broker configuration, and native `ask` rules for receive/search. Loading the ordinary package directory selects the **paired** server entry, not the stock experiment.
- An isolated Agent Bus broker and the deterministic provider in `tests/integration/stock-fixture-provider.ts`. The provider makes no external model calls. Choose its loopback port explicitly with `STOCK_FIXTURE_PORT` and configure the host to use it.
- For the wake driver, enable `wakeOnMessage: true`; keep approval focus off. Prepare two disposable Git projects with distinct host project IDs and the required Agent Bus policy in both. Different directories of one project do not test cross-project saved grants.
- A private test-launcher log containing the line `server password <test-only-password>`. This is the drivers' credential input convention, **not** a promise that the standard CLI prints such a line. Never reuse a production log or password.

The host and provider startup/cleanup remain the test operator's responsibility. Use a controlled terminal or owned tmux sessions. The drivers close their client event subscriptions, but do not stop your externally provisioned server, provider, or broker.

## Configure the clients explicitly

All paths and ports are supplied by the operator; there are no machine-specific defaults:

```bash
export AGENTBUS_STOCK_TEST_MODE=isolated
export AGENTBUS_STOCK_SERVER_URL=http://127.0.0.1:44001
export AGENTBUS_STOCK_SERVER_LOG=/absolute/path/to/disposable-state/server.log
export AGENTBUS_STOCK_PROJECT=/absolute/path/to/disposable-project-a

# Also required by the wake driver:
export AGENTBUS_STOCK_OTHER_PROJECT=/absolute/path/to/disposable-project-b
export AGENTBUS_STOCK_PROVIDER_URL=http://127.0.0.1:44002
```

Replace every example value and match the ports to the actual isolated services. The provider URL is its origin, without an API path. The clients reject missing isolation intent, non-loopback endpoints, and relative paths before reading the test credential or contacting the server. This explicit configuration is a safety guard, not an independent attestation that an operator-provided server is isolated.

From the repository root, run one client at a time against a freshly provisioned experiment:

```bash
bun packages/plugin/test/stock-host-driver.ts
bun packages/plugin/test/stock-wake-host-driver.ts
```

The first driver covers native search/receive approval, send/reply/return correlation, same-project exact `always`, plain/feedback rejection, interruption, moved-session identity and a misconfigured `allow` failing closed. It expects wake disabled for its manual receive steps. The second driver expects wake enabled and covers autonomous receive, preapproval body privacy, busy deferral, move tolerance, rejection coalescing, interruption/deletion, and cross-project `always` behavior.

## Interpret the evidence

- A native permission reply from these drivers is a **test-driver decision**, not human QA acceptance.
- The wake provider exposes only aggregate `/__metrics` counters. Do not publish raw credentials, prompts, peer bodies, session IDs, or machine paths from native logs.
- The wake driver's `UNMET: native always approval is project-scoped` message is an intentional diagnostic of a known product mismatch. The driver can exit successfully after observing it; that exit code is **not** a passing cross-project approval gate.
- Queue acceptance, an autonomous receive call, and completed approved delivery are distinct observations. Keep each explicit in the report.
- Prior runs used earlier source snapshots. After changes, record the exact commit, host version, package-copy/install method, configuration intent, command exits and cleaned-up process ownership. Do not reuse historical pass counts as a run of new code.

Remaining limits, including uncertain wake recovery and dependency advisories, are recorded in [V2 integration status](v2-port.md). Release and packaging decisions remain separate from these manual probes.
