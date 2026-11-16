# Release preparation and the OpenCode V1 → V2 transition

V1 `0.1.0` has been published from protected tag `opencode-v1/v0.1.0` and preserved on `maintenance/opencode-v1`. This procedure keeps that released line available while preparing a separate OpenCode V2 source. It separates building a package from authorizing its distribution. **Preparing V2 does not authorize a V2 release, tag or npm publication.**

The host generations called **V1/V2** here are different from Agent Bus's application protocol v2, which both adapters use.

## Source lines and packages

`release.config.json` is the source of truth for the active release line, exact package version, package names, supported build profiles and publication gates.

| Source state | Active release | Package | Tag example |
|---|---|---|---|
| Released V1 source, preserved on `maintenance/opencode-v1` | `v1` | `@atacama-dev/opencode-agentbus-v1` | `opencode-v1/v0.1.0` |
| V2 integration candidate; not released | `v2` | `@atacama-dev/opencode-agentbus-v2` | `opencode-v2/v0.1.0` (future only) |

The V1 package exists on npm; the V2 name is configured but not published or reserved by this workflow. Confirm rights before enabling any new publication. A GitHub organization does not automatically own the matching npm scope.

The released V1 source was built from the V1 `main` line with shared security/build corrections backported; the protected tag does not acquire V2 runtime dependencies or V2 ancestry. The V2 source can build both adapters for compatibility checks, but its active release line remains `v2`: that does not authorize another V1 release from the V2 line. The workspace plugin package root still exports the legacy V1 adapter, and its `./server` entry is paired-host-only; these development exports do not select the public npm V2 archive entry.

Each published release selects **one** package matching the active line. Branch/PR builds may produce both profiles where supported. Versions are plugin versions; `0.1.0` does not claim compatibility with OpenCode 0.1 or every release of its host generation.

## What the package contains

The artifact is prebuilt JavaScript with matching declarations, GPL license and installation instructions. Our broker/protocol packages are included as real bundled dependencies, not workspace symlinks or unpublished `workspace:` references. Third-party dependencies remain explicit; bundling must not hide vulnerable third-party code from the audit.

V1 loads the legacy plugin function. V2 loads the public stock adapter, **not** the paired-host server or its unsupported terminal/RPC companion. The stock adapter remains experimental and requires its explicit experimental option until the compatibility gates are accepted. Packaging does not add missing native `always` portability, wake recovery, discovery or UI behavior.

The user still needs Linux, Bun and a compatible OpenCode version. The broker is provided with the plugin and can autostart; the package does not install or replace OpenCode or Bun. Keep V1/V2 test credentials, endpoints and databases independent unless a shared deployment has been deliberately validated.

A previously running detached broker survives a plugin upgrade. Installing a package does not replace or stop it, even when its application protocol is still compatible. To activate bundled broker security fixes, the operator must deliberately stop the old user-owned broker and then let the new bundled broker start, preserving the intended credential and database. This procedure does not restart any existing service automatically.

## Local preparation and CI evidence

From a checkout with dependencies installed and product build complete:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run release:pack --line v1 --out release-artifacts
bun run release:smoke --manifest release-artifacts/v1/manifest.json
```

On a V2-capable source, repeat with `--line v2` and the matching manifest. A V1-only source must reject that profile rather than importing V2 modules.

The packer creates an actual npm `.tgz` and a manifest identifying its line, name, version, source commit and SHA-256. The smoke test installs **that archive** into an independent consumer without dependency lifecycle scripts, checks the packaged entry/broker behavior, and type-checks the installed public entry and bundled broker declarations with `skipLibCheck: false`. The V2 profile explicitly supplies the JSON Schema declaration package needed by its upstream SDK's public types. These checks are not a substitute for acceptance on a real OpenCode host.

CI checks the source and packages on pushes and pull requests. Build evidence may be produced while publication is disabled. Raw audit findings remain visible. Uncovered findings, invalid evidence and expired applicable exceptions block distribution; the only accepted findings are those matching the [temporary risk-acceptance policy](dependency-exceptions.md). Do not silently drop findings or force incompatible dependency versions.

Do not compare unlike audit counters: Bun's saved workspace report counts advisory records; npm also reports affected packages and their dependent ancestors. The first isolated package installs reported six distinct advisory records for V1 and two for V2, shown by npm as five high-affected packages and 25 moderately affected packages respectively. This does not mean packaging introduced 25 new vulnerabilities. Raw reports remain nonzero even when all their exact instances meet the temporary exception policy.

The archive digest fixes our distributed package bytes, not every future registry resolution: direct third-party dependencies are pinned, but their own compatible ranges can resolve differently for a later consumer. CI retains the inspected production graph and re-audits each release install. A fully locked transitive distribution would require a separate reviewed shrinkwrap/offline-install design; it is not claimed here.

Local artifacts built from a dirty checkout are development previews, not evidence that a tag contains those exact changes. The release path requires a clean, verified checkout of the annotated tag and distributes the same archive that passed its gates. Artifacts are ignored by Git.

## Before any future release

All of the following are owner-controlled prerequisites, not actions the workflow takes on your behalf:

1. Confirm the target package name and npm scope ownership. Complete any required first-package registration/bootstrap without publishing an unreviewed placeholder under the intended release version.
2. Configure npm trusted publishing for this repository and the exact `release.yml` workflow filename, with the protected environment used by that release line. Follow [npm's trusted-publisher instructions](https://docs.npmjs.com/trusted-publishers/). No permanent write token belongs in the repository.
3. Configure required review for the publication environments and protect `main`, the maintenance branches and both release-tag prefixes against unauthorized changes. **An annotated tag alone is not immutable**: repository rules must prevent moving or deleting accepted release tags.
4. Verify the repository remains public. OIDC publishing itself can work from private repositories, but npm's automatic public provenance cannot. Our public-publication policy requires a public repository; preparation must not change visibility automatically.
5. Resolve all uncovered production findings and complete the line-specific functional/security gates. Temporary acceptance is limited to the exact advisory/version/chain entries and dates in the reviewed exception ledger; it is not a clean dependency audit. Review the actual production install of each package separately and re-evaluate the policy at publication time.
6. Record the reviewed version and explicitly mark the selected line ready in `release.config.json`; enable npm publication only after external setup and owner review. In the V2 integration candidate, V1 readiness is true as historical release state; V2 readiness and publication are false.

The [V2 integration status](v2-port.md) and [manual V2 procedure](manual-v2-qa.md) record its limitations and native-host acceptance gaps. The V1 [QA record](qa.md) remains applicable to its own source; do not copy a V2 test result to qualify a V1 backport.

## Historical V1 bootstrap and remaining rollout

### Initial V1 0.1.0 bootstrap

The maintainer authorized and completed the first V1 `0.1.0` publication on 2026-11-16, explicitly accepting the [deferred fresh manual native-host checks](qa.md#initial-v1-010-release-decision). The V1 release-source readiness/publication switches record that historical decision, not a claim that those checks passed; V2 readiness stays false.

npm required an existing package before trusted publishing could be configured. For V1's first real package only, the approved bootstrap interactively published the **exact archive downloaded from a fully successful CI run on the protected annotated release tag**, with lifecycle scripts disabled. Its source commit, manifest, archive hash and installed-audit decision were verified before publication, then registry SHA-512 integrity was verified. No placeholder was deliberately published, and no permanent npm token was added to CI. This initial publication has **no OIDC provenance** and must not be described as trusted-published.

The GitHub release was published on that same tag after registry integrity matched. The historical release workflow did not finish green: its npm CLI version probe hit a double-loaded config error before publication, and the verified matching assets were recovered without another npm write. The later mainline `npmConfigPaths` fix applies to future releases only, not to the immutable V1 tag. Configure trusted publishing when a subsequent real publication is ready, accounting for npm's two-day first-use deadline. This one-time bootstrap does not add a token fallback or relax subsequent publication checks.

### 1. V1 release from `main` (completed)

The main-based V1 preparation was reviewed with release line `v1`, exact package name and version, and tagged-source gates. Its protected release commit remains immutable.

An **annotated** `opencode-v1/v0.1.0` tag and a GitHub release select that reviewed commit. The final version maps to npm `latest`; a future semantic prerelease would instead map to `next`.

The workflow builds/verifies the tagged source, not whatever `main` happens to contain later. It must confirm the tag's commit belongs to the approved source line and that the archive name/version/digest match before external writes. It does not create extra release tags or branches.

### 2. Preserve V1 (completed)

The protected tag retains the exact V1 release commit. `maintenance/opencode-v1` preserves the final V1 source tree, including the later logo and npm-config publication correction; its active release line remains `v1`. Subsequent V1 fixes belong on this branch, without changing the accepted release tag or importing V2 runtime dependencies.

### 3. Integrate V2 into `main` (pending review)

Review the integration candidate against the V1-released `main`, including its shared security/build backports. Do not blindly merge duplicated backports or rewrite an already-published branch history. Only after that review and merge will `main` select `v2` and the V2 package; the frozen V1 tag remains unchanged.

### 4. Release and preserve V2

After the V2 gates pass, create/push the reviewed annotated `opencode-v2/v<version>` tag and publish its GitHub release. Preserve the accepted commit on `maintenance/opencode-v2` as well. Both maintenance lines can retain their own tags and package versions without replacing the other generation's npm package.

## Failed or repeated publication

Keep the tested archive and its manifest. Do not rebuild inside a privileged publication job or overwrite an existing asset blindly. An npm version is immutable: an existing identical package may be recognized on retry, while a different archive for the same name/version must stop for operator investigation. Existing GitHub release assets likewise must match before being reused.

If one external write succeeds and another fails, resume from the verified artifact rather than changing or deleting the released version. Do not move an old version back onto `latest` merely because a historical workflow was retried. Never delete, force-update or replace a release tag to repair a pipeline.

Publication jobs must serialize per package/host line, not merely per release tag. Before a first publish of a version, compare it to the current `latest` or `next` target and refuse an older version. npm does not provide a compare-and-swap guarantee for this operation: any manual or other external publishers must coordinate with the single CI writer. GitHub concurrency may replace pending jobs; retry the intended job with its existing tested archive rather than assuming every queued release will run in order.
