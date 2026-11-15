# Temporary dependency risk acceptance

This policy permits only explicitly reviewed dependency findings to pass the audit gate while keeping the raw vulnerabilities visible. **An accepted finding is not a false positive, a fix, or proof that the installed dependency is harmless.**

The maintainer approved temporary, narrowly scoped exceptions on 2026-11-15. They expire at **2026-12-15 00:00 UTC**, 30 days later, and must not renew automatically. The machine-readable ledger is [`security/audit-exceptions.json`](../security/audit-exceptions.json).

## Review boundary

Each exception identifies an advisory, severity, affected package, exact installed versions and reviewed SDK dependency chains. Production scopes also identify the release line. Its rationale and evidence must remain applicable. A matching package name or vulnerable version range alone is insufficient: a new route or release line is a new exposure to review.

The current review covers these eight advisory records:

| Dependency | Advisory | Current exposure and evidence |
|---|---|---|
| Legacy SDK Zod | `GHSA-mrhx-c7xc-m3w5` | The SDK's vulnerable copy remains installed, but the four legacy tool argument schemas accept only scalar strings/numbers and optional scalars. The regression guard inspects the actual tool definitions and checks rejection of collection inputs. Broker/protocol collection validation uses patched Zod 4.6.7. |
| Legacy Effect cookies | `GHSA-chp3-j5qr-2vfr` | Agent Bus does not use the affected cookie serialization API. The vulnerable beta is pulled in by the legacy SDK, not the public V2 stable Effect dependency. |
| Legacy TOML | `GHSA-h895-cgqg-jf52`, `GHSA-4qx8-w7c3-pj3p`, `GHSA-9j65-hcg3-gc64`, `GHSA-9qmh-m7c6-f92p` | The legacy SDK/Effect chain installs the affected TOML parser; Agent Bus does not parse peer data or configuration through it. |
| Public SDK glob | `GHSA-3g3m-2fjr-6pw4` | The public SDK's utility dependencies install affected glob versions. Agent Bus's current messaging entry does not invoke them on peer-controlled patterns. |
| Public SDK minimatch | `GHSA-g3hv-75wg-m249` | The same utility chains install affected matchers. Registry search uses literal substring matching, not this pattern engine. |

The exact versions and chains in the ledger govern acceptance; the table is explanatory, not an additional allowlist. Installed dependency copies outside those chains are not covered. V1's source ledger contains only its six legacy-SDK advisories, not the V2-only glob/minimatch scopes. V2's source checks both package profiles independently.

[`advisory-exposure.test.ts`](../packages/plugin/test/advisory-exposure.test.ts) guards the actual legacy argument schema shapes and direct parser/import exposure. This is a current-call-surface regression guard, **not** whole-program analysis of OpenCode or a sandbox against co-resident plugins. Changes to caller behavior or SDK APIs require another exposure review even if a dependency version stays the same.

## Audit gate behavior

- Retain the original Bun/npm reports and installed-dependency evidence. Report accepted risks separately; never rewrite a raw report into a clean result.
- Match leaf advisory records and actual affected instances. npm's dependent-package propagation must not turn two advisory records into 25 unrelated exceptions, nor conceal a new leaf finding.
- Fail on an uncovered advisory, a critical finding, changed severity/version/chain, invalid or missing evidence, and applicable expired or not-yet-active exceptions.
- Use the real UTC clock in CI and immediately before publication; unit tests may inject time solely to prove boundary behavior.
- Preserve failure for registry errors, malformed audit output and inconsistent installed graphs. An unavailable audit is not an accepted risk.

Run the workspace audit with `bun run audit`. Its raw report, installed context, exit status and separate decision are retained under `.local/audit-evidence/workspace/`. CI retains corresponding evidence as workflow artifacts.

After packaging and consumer smoke, recheck an archive with `bun scripts/release/policy.ts audit release-artifacts/v1/manifest.json` (or `v2`). The matching `audit.json`, `audit-context.json` and `audit-exit.json` must be beside the manifest. Context records the build-observed installed dependency instances against the source commit, profile, package identity and archive digest. It is build-produced evidence, not an independent cryptographic attestation or a fresh installation in the publication job. A saved `audit-decision.json` is explanatory evidence, not publication authority: publication recomputes the decision from the raw evidence and source ledger before each write.

The summary distinguishes raw findings from accepted findings. A successful `accepted-temporary-risk` result still means vulnerabilities are installed. There is no `continue-on-error`, global package exclusion, or incompatible dependency override in this policy.

## Responsibility and follow-up

Responsible maintainer: **Julien Tesson**. Before expiry, obtain compatible upstream fixes, remove genuinely unnecessary dependencies through a reviewed design, or perform and record a new risk review. Delete obsolete exceptions when fixes remove the finding. Do not broaden a chain or version entry just because a new install no longer matches.

Historical release retries are subject to the current clock as well: an expired exception must not become valid merely by replaying an old CI decision. Do not move an immutable release tag to renew its acceptance.

Passing this audit policy does **not** mark either release line ready, enable npm publication, make the repository public, or establish native OpenCode acceptance. The existing release configuration, protected refs/environments, source/archive checks and product acceptance requirements remain separate gates.
