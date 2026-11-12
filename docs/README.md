# Knowledge base

This directory is the project knowledge base. Keep it aligned with implemented and verified behavior.

| Document | Authority |
|---|---|
| [`requirements.md`](requirements.md) | Canonical functional and non-functional requirements |
| [`architecture.md`](architecture.md) | Components, trust boundaries, state machines, and message flow |
| [`broker-lifecycle-decision.md`](broker-lifecycle-decision.md) | Accepted broker ownership, autostart, contention, and recovery decision |
| [`../AGENTS.md`](../AGENTS.md) | Mandatory implementation invariants and delivery gates |
| [`implementation-plan.md`](implementation-plan.md) | Delivery history and deterministic evaluation criteria |
| [`qa.md`](qa.md) | Verified acceptance evidence and remaining release gates |
| [`manual-qa.md`](manual-qa.md) | Opt-in attached-client procedure with operator-supplied paths and service settings |
| [`licensing.md`](licensing.md) | GPL choice, dependency compatibility evidence, and redistribution limits |

`README.md` at the repository root is the operator guide. If an operational example conflicts with the requirements or security invariants, the requirements and invariants take precedence.
