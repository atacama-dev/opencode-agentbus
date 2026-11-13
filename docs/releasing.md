# Release preparation and the OpenCode V1 → V2 transition

This procedure keeps an installable OpenCode V1 release available while `main` later moves to OpenCode V2. It separates building a package from authorizing its distribution. **No release, tag, merge, or npm publication is performed by preparing these files.**

The host generations called **V1/V2** here are different from Agent Bus's application protocol v2, which both adapters use.

## Source lines and packages

`release.config.json` is the source of truth for the active release line, exact package version, package names, supported build profiles and publication gates.

| Source state | Active release | Package | Tag example |
|---|---|---|---|
| Reviewed V1 preparation merged into `main`, then preserved on `maintenance/opencode-v1` | `v1` | `@atacama-dev/opencode-agentbus-v1` | `opencode-v1/v0.1.0` |
| Reviewed V2 integration merged into `main`, then preserved on `maintenance/opencode-v2` | `v2` | `@atacama-dev/opencode-agentbus-v2` | `opencode-v2/v0.1.0` |

The npm names are **proposed configuration, not reserved or owned by this workflow**. Confirm the npm organization and package rights before enabling publication. A GitHub organization does not automatically own the matching npm scope.

The V1 preparation is built from the existing V1 `main` source, with shared security/build corrections backported. It must not acquire V2 runtime dependencies or V2 ancestry merely to obtain packaging scripts. The V2 source can build both adapters for compatibility checks, but its active release line remains `v2`: that does not authorize a V1 release from the V2 line.

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

CI checks the source and packages on pushes and pull requests. Build evidence may be produced while publication is disabled. A failed production audit must remain visible and must block release distribution; it is not a reason to silently drop findings or force incompatible dependency versions.

Do not compare unlike audit counters: Bun's saved workspace report counts advisory records; npm also reports affected packages and their dependent ancestors. The first isolated package installs reported six distinct advisory records for V1 and two for V2, shown by npm as five high-affected packages and 25 moderately affected packages respectively. This does not mean packaging introduced 25 new vulnerabilities. Both reports remain nonzero and block publication.

The archive digest fixes our distributed package bytes, not every future registry resolution: direct third-party dependencies are pinned, but their own compatible ranges can resolve differently for a later consumer. CI retains the inspected production graph and re-audits each release install. A fully locked transitive distribution would require a separate reviewed shrinkwrap/offline-install design; it is not claimed here.

Local artifacts built from a dirty checkout are development previews, not evidence that a tag contains those exact changes. The release path requires a clean, verified checkout of the annotated tag and distributes the same archive that passed its gates. Artifacts are ignored by Git.

## Before the first release

All of the following are owner-controlled prerequisites, not actions the workflow takes on your behalf:

1. Confirm the package names and npm scope ownership. Complete any required first-package registration/bootstrap without publishing an unreviewed placeholder under the intended release version.
2. Configure npm trusted publishing for this repository and the exact `release.yml` workflow filename, with the protected environment used by that release line. Follow [npm's trusted-publisher instructions](https://docs.npmjs.com/trusted-publishers/). No permanent write token belongs in the repository.
3. Configure required review for the publication environments and protect `main`, the maintenance branches and both release-tag prefixes against unauthorized changes. **An annotated tag alone is not immutable**: repository rules must prevent moving or deleting accepted release tags.
4. Decide when the repository becomes public. OIDC publishing itself can work from private repositories, but npm's automatic public provenance cannot. Our public-publication policy requires a public repository; preparation must not change visibility automatically.
5. Resolve the production dependency audit and complete the line-specific functional/security gates. The current eight workspace findings are not waived by this workflow. Review the actual production install of each package separately.
6. Record the reviewed version and explicitly mark the selected line ready in `release.config.json`; enable npm publication only after external setup and owner review. The initial readiness and publication switches are deliberately false.

The [V2 integration status](https://github.com/atacama-dev/opencode-agentbus/blob/julien%40opencode-v2/docs/v2-port.md) and [manual V2 procedure](https://github.com/atacama-dev/opencode-agentbus/blob/julien%40opencode-v2/docs/manual-v2-qa.md) are maintained on the V2 development line and record its limitations and native-host acceptance gaps. The V1 [QA record](qa.md) remains applicable to its own source; do not copy a V2 test result to qualify a V1 backport.

## Rollout, when everything is ready

### 1. Release V1 from `main`

Integrate and review the main-based V1 preparation first. Check that its release line is `v1`, its package name and version are correct, and its gates pass on that exact source.

Create and push an **annotated** `opencode-v1/v<version>` tag on the reviewed commit. In GitHub, publish a release selecting that existing tag. Mark a semantic prerelease such as `0.1.0-beta.1` as a GitHub prerelease; it maps to npm `next`. A final version maps to npm `latest`.

The workflow builds/verifies the tagged source, not whatever `main` happens to contain later. It must confirm the tag's commit belongs to the approved source line and that the archive name/version/digest match before external writes. It does not create extra release tags or branches.

### 2. Preserve V1

After the V1 release is accepted, create `maintenance/opencode-v1` at that release's commit. Keep the annotated release tag. This branch is where any later V1 fixes are reviewed; its active release line remains `v1`.

### 3. Integrate V2 into `main`

Prepare a reviewed integration against the then-current `main`, including its V1 release preparation and security backports. Do not blindly merge duplicated backports or rewrite an already-published branch history. Resolve the release configuration deliberately: `main` now selects `v2` and the V2 package, without changing the frozen V1 tag.

### 4. Release and preserve V2

After the V2 gates pass, create/push the reviewed annotated `opencode-v2/v<version>` tag and publish its GitHub release. Preserve the accepted commit on `maintenance/opencode-v2` as well. Both maintenance lines can retain their own tags and package versions without replacing the other generation's npm package.

## Failed or repeated publication

Keep the tested archive and its manifest. Do not rebuild inside a privileged publication job or overwrite an existing asset blindly. An npm version is immutable: an existing identical package may be recognized on retry, while a different archive for the same name/version must stop for operator investigation. Existing GitHub release assets likewise must match before being reused.

If one external write succeeds and another fails, resume from the verified artifact rather than changing or deleting the released version. Do not move an old version back onto `latest` merely because a historical workflow was retried. Never delete, force-update or replace a release tag to repair a pipeline.

Publication jobs must serialize per package/host line, not merely per release tag. Before a first publish of a version, compare it to the current `latest` or `next` target and refuse an older version. npm does not provide a compare-and-swap guarantee for this operation: any manual or other external publishers must coordinate with the single CI writer. GitHub concurrency may replace pending jobs; retry the intended job with its existing tested archive rather than assuming every queued release will run in order.
