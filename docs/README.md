# Knowledge base

This directory is the project knowledge base. Keep it aligned with implemented and verified behavior.

| Document | Authority |
|---|---|
| [`requirements.md`](requirements.md) | Canonical functional and non-functional requirements |
| [`architecture.md`](architecture.md) | Components, trust boundaries, state machines, and message flow |
| [`session-identity-decision.md`](session-identity-decision.md) | Owner decision: project association is discovery metadata, stable session identity governs authorization, automatic wake remains required |
| [`broker-lifecycle-decision.md`](broker-lifecycle-decision.md) | Accepted broker ownership, autostart, contention, and recovery decision |
| [`../AGENTS.md`](../AGENTS.md) | Mandatory implementation invariants and delivery gates |
| [`implementation-plan.md`](implementation-plan.md) | Delivery history and deterministic evaluation criteria |
| [`qa.md`](qa.md) | Verified acceptance evidence and remaining release gates |
| [`manual-qa.md`](manual-qa.md) | Opt-in attached-client procedure with operator-supplied paths and service settings |
| [`licensing.md`](licensing.md) | GPL choice, dependency compatibility evidence, and redistribution limits |
| [`v2-port.md`](v2-port.md) | Public OpenCode V2 compatibility blocker and integration status |
| [`manual-v2-qa.md`](manual-v2-qa.md) | Explicitly isolated native V2 approval and wake probes; prerequisites and evidence limits |

`README.md` at the repository root is the operator guide. If an operational example conflicts with the requirements or security invariants, the requirements and invariants take precedence.
