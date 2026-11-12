# Licensing and dependency review

Agent Bus's own code is licensed under **GPL-3.0-or-later**; the local dependency review found no confirmed incompatibility with GPLv3 for the current source-only repository. This is not clearance for a future bundled binary or a determination of copyright ownership.

## Evidence and choice

On 2026-11-12, a read-only review inspected the workspace manifests, `bun.lock`, installed runtime dependency metadata, and available license texts. It covered 113 installed third-party runtime package/version pairs; the locked runtime closure contains 118 pairs, including five optional platform packages not installed locally. Development tools were considered separately.

That inventory describes the baseline before the shared dependency-security refresh to MCP SDK 1.32.2 and direct Zod 4.6.7 and before the public OpenCode V2 SDK dependencies were added. The legacy OpenCode plugin still pins Zod 4.1.8. The refreshed V1 and experimental V2 graphs need a renewed full inventory and notice review before redistribution; the baseline counts above are not a current package-clearance claim. The integration's dependency-security advisory count is tracked separately in [V2 integration status](v2-port.md).

| Dependencies | License / compatibility basis |
|---|---|
| `@modelcontextprotocol/sdk@1.32.2`, `@opencode-ai/plugin@1.18.19`, `@opencode-ai/sdk@1.18.19`, both resolved Zod versions (4.6.7 and legacy-pinned 4.1.8) | MIT; compatible with GPLv3 |
| `@ai-sdk/provider@3.0.8`, `detect-libc@2.1.2`, `kubernetes-types@1.30.0` | Apache-2.0; compatible with GPLv3, not GPLv2-only |
| `json-schema@0.4.0` | `(AFL-2.1 OR BSD-3-Clause)`; use the BSD-3-Clause option |
| Other inspected runtime dependencies | MIT, ISC, BSD-2-Clause, or BSD-3-Clause |

This is why the project uses GPL version 3 or later rather than GPLv2-only. Dependency declarations do not relicense upstream code. The complete GPLv3 text is in [LICENSE](../LICENSE); the project grant, including the later-version option, is in the [README](../README.md#license) and workspace manifests.

## Before redistributing dependencies or binaries

The tracked source repository does not vendor `node_modules` or Bun. Building with a tool does not by itself apply that tool's license to the generated code. If a future distribution includes dependencies, executable bundles, or Bun:

- Preserve all applicable upstream copyright, license, disclaimer, and NOTICE material, including the full JSON Schema/IETF notice in `json-schema-typed@8.0.2`.
- Include the complete Apache-2.0 terms where required; the installed `@ai-sdk/provider` license file contains only a short notice/link.
- Obtain authoritative notice texts missing from the installed `@opencode-ai/plugin`, `@opencode-ai/sdk`, `kubernetes-types`, and Linux x64 `@msgpackr-extract` packages before conveying those packages.
- Verify the five other locked optional `@msgpackr-extract` platform packages; they were unavailable for local inspection. Recheck any newly resolved optional peers and build-tool binaries that will be redistributed.
- Review Bun's embedded third-party components separately if bundling its executable. The MIT metadata of the `bun@1.3.9` npm wrapper is not a complete statement of the executable's component licenses.
- Meet GPL corresponding-source and notice obligations for the actual distribution. A private repository and `private: true` do not exempt conveyance to recipients.

The review did not verify package contents against registry tarballs, audit every file's provenance, or establish ownership of contributions. Changing Git attribution is not a transfer of copyright. Recheck these limits and the dependency graph when preparing a public or packaged release.
