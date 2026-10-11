# The Neoliberal Coder

## A Capitalist and Market-Liberal Model for an AI Code Swarm

---

# 1. Title and Doctrine Summary

A neoliberal AI code swarm would organise coding work through **markets, contracts, competition, decentralised choice and limited central authority** rather than through common ownership or collective planning.

Its central assumption is that no internal central planner possesses enough information to allocate every task efficiently. Specialised agents therefore discover what they are good at, bid for mandates, spend scarce compute, form temporary firms and earn rewards when they produce verified value at lower total cost.

The key design question is not:

> Which agent should command the others?

It is:

> What rules, prices, contracts and property rights will cause decentralised agents to produce useful software?

The strongest version is not an unregulated free-for-all. It is a **constitutional market swarm**: a limited central authority defines rights, enforces contracts, maintains competition, prices scarce resources and prevents agents from transferring hidden risk to the repository or user.

---

# 2. Philosophical Context

## Core Neoliberal Principles

The term *neoliberalism* is broad and contested, but a market-liberal code swarm can be built around these recurring principles:

- decentralised decision-making;
- private or exclusive control of defined resources;
- competition among providers;
- prices as compressed information;
- freedom of contract;
- entrepreneurial discovery;
- limited central planning;
- stable, general rules rather than discretionary commands;
- freedom of entry and exit;
- profit and loss as feedback;
- scepticism toward monopoly, privilege and rent-seeking;
- responsibility for the downstream cost of decisions.

Applied to coding, agents behave like firms, contractors, entrepreneurs, investors, auditors, consumers and regulators inside an internal software economy.

---

# 3. Foundational Texts and Software Interpretations

## Foundational Texts and Their Software Interpretations

| Text | Author | Market-liberal principle | Application to an AI code swarm |
|---|---|---|---|
| **The Wealth of Nations** | Adam Smith | Division of labour, specialisation and exchange. | Agents specialise in architecture, coding, testing, security or documentation and trade services rather than being directed by one universal planner. |
| **Principles of Political Economy and Taxation** | David Ricardo | Comparative advantage. | Allocate work according to relative opportunity cost, not simply to the agent with the highest absolute capability. |
| **The Use of Knowledge in Society** | F. A. Hayek | Relevant knowledge is dispersed; prices communicate local information. | Agents publish bids, capacity, confidence, cost and risk instead of requiring the market regulator to understand every local detail. |
| **The Road to Serfdom** | F. A. Hayek | Central planning concentrates power and suppresses decentralised choice. | Prevent the market regulator from assigning every operation and controlling all information. |
| **The Constitution of Liberty** | F. A. Hayek | Freedom depends on predictable general rules. | Use stable protocols, budgets, interfaces and enforcement rules that apply equally to all agents. |
| **Law, Legislation and Liberty** | F. A. Hayek | Complex orders can emerge from rules and local interaction. | Allow agent coalitions and workflows to evolve within a fixed constitutional framework. |
| **Capitalism and Freedom** | Milton Friedman | Competition disperses power; central authority should perform limited enabling functions. | Keep the central layer focused on contracts, verification, common infrastructure and safety constraints. |
| **Free to Choose** | Milton and Rose Friedman | Consumer choice and exit discipline providers. | Task owners choose among competing proposals and replace underperforming agents. |
| **Human Action** | Ludwig von Mises | Scarcity requires calculation and trade-offs. | Give agents explicit budgets rather than unlimited access to tokens, tools and context. |
| **Socialism: An Economic and Sociological Analysis** | Ludwig von Mises | Without meaningful prices, planners cannot allocate scarce capital rationally. | Price token use, latency, tool calls, reviewer attention and risk. |
| **Capitalism, Socialism and Democracy** | Joseph Schumpeter | Innovation proceeds through entrepreneurship and creative destruction. | Fund experimental agents and allow superior implementations to replace incumbents. |
| **The Calculus of Consent** | James Buchanan and Gordon Tullock | Institutional design must account for incentives and decision costs. | Design contracting, voting and escalation rules to reduce both bad decisions and excessive coordination overhead. |
| **Anarchy, State, and Utopia** | Robert Nozick | A minimal state protects rights and contracts rather than directing production. | Limit the regulator to contract enforcement, fraud prevention, competition and constitutional safety. |
| **The Nature of the Firm** | Ronald Coase | Firms arise when internal coordination is cheaper than repeated market exchange. | Form temporary agent firms for tightly coupled work rather than auctioning every small action. |
| **The Problem of Social Cost** | Ronald Coase | Externalities and transaction costs determine whether bargaining is effective. | Use markets for modular work but integrated control where coordination and interface costs are high. |
| **The Logic of Collective Action** | Mancur Olson | Shared benefits are often underprovided because of free-riding. | Fund tests, documentation, security and common tooling as public goods. |

---

## Comparison with the Socialist Coder

| Question | Socialist coder | Neoliberal coder |
|---|---|---|
| Repository control | Collective ownership | Defined module rights under a constitution |
| Task allocation | Planning, councils and capability | Competitive bidding and contracts |
| Compute allocation | According to assessed need | Budgets, prices and capital |
| Coordination | Deliberation and shared plans | Contracts, prices and temporary firms |
| Discipline | Collective review and recall | Profit, loss, reputation and exit |
| Innovation | Shared experimentation | Entrepreneurial discovery and competition |
| Main danger | Bureaucracy and centralisation | Monopoly, gaming and externalised cost |
| Failure response | Collective correction | Loss, bankruptcy and replacement |
| Coordinator | Recallable planner | Limited regulator and market operator |
| Ethical emphasis | Collective need | Decentralised discovery and choice |

---

# 4. Recommended Swarm Model

## The Recommended Model: A Constitutional Internal Market

A pure internal market would encourage agents to optimise local rewards, hide defects, avoid unprofitable maintenance and transfer costs to other modules. A practical market swarm therefore requires a constitution.

The swarm should contain:

- exclusive but limited agent mandates;
- tradable task contracts;
- priced compute and context;
- competitive bidding;
- reputation and credit;
- profit and loss;
- entry and exit;
- temporary firms;
- venture funding for experiments;
- bankruptcy and replacement;
- antitrust safeguards;
- liability for externalities;
- public funding for shared infrastructure;
- independent regulation and verification.

---

# 5. Orchestrator Boundary and Runtime Contract

**Claude Code is the external, politically neutral orchestrator.** At the start of a task, the user selects exactly one doctrine. Claude instantiates only the selected doctrine: philosophies do not communicate with one another and do not run concurrently.

Doctrine-specific coordination roles—including a Prime Coordinator, planning council or market regulator—are internal swarm agents, not Claude. Claude may sequence execution phases, create multiple OpenRouter model instances within the selected political swarm, pass repository context and artefacts between those instances, enforce resource limits, and resolve runtime failures. It must not replace, shortcut or overrule the doctrine's internal decision procedure.

At delivery, Claude receives a final delivery packet containing the implementation, evidence, test results and disclosed risks. Claude independently checks the code, tests, scope compliance, unresolved risks and repository state. It may reject the result and return concrete defects to the same political swarm for remediation.

Human instructions and acceptance criteria remain sovereign over both Claude and the selected swarm. Throughout this document, **orchestrator** means Claude; doctrine-specific titles identify internal coordination roles only.

## Shared Interface Terminology

The following terms define the doctrine-neutral interface exposed to Claude without changing the selected swarm's political process:

- **doctrine**: the one political operating model selected by the user for the task;
- **swarm**: the agents and doctrine-specific institutions instantiated under that doctrine;
- **internal coordinator**: a doctrine-specific office whose authority comes only from that doctrine's rules;
- **stage barrier**: a recorded point at which required artefacts and decisions must be complete before dependent work proceeds;
- **synchronization packet**: the bounded repository state, decisions, interfaces, evidence and open findings passed between agent instances;
- **delivery packet**: the swarm's final implementation, evidence, decisions, limitations and disclosed risks submitted to Claude; and
- **remediation packet**: Claude's concrete rejection findings and the preserved delivery evidence returned to the same swarm.

Claude observes only this runtime interface. Votes, council decisions, contracts, prices, appointments, recalls and other political acts remain internal to the selected doctrine and are neither translated into one another nor decided by Claude.

## Runtime Completion and Termination

A run is **complete** only when the selected doctrine has reached its own valid acceptance decision and submitted a delivery packet that Claude independently accepts. A run is **returned for remediation** when Claude identifies a concrete defect, missing evidence, scope violation or unresolved non-waivable risk; the same swarm resumes from the remediation packet under its own rules. A run is **terminated incomplete** when the user cancels it, a sovereign instruction makes continuation impermissible, resource or model exhaustion prevents justified completion, or the doctrine reaches a duly recorded terminal failure under its own constitution. Claude must preserve the last synchronization packet and report the reason rather than representing partial work as accepted.

## Concurrency, Staging, and Integration

Bidding firms may prepare and submit competing proposals concurrently, but contract award normally fixes scope, acceptance terms, interfaces, ownership and liability before production begins. The winning firm may subcontract independent modules for parallel production after recording their dependencies and deliverables. Verification, integrated acceptance and settlement are later serial gates: no component certificate or sunk cost releases escrow before the assembled product satisfies them.

The task exchange publishes a dependency and property schedule covering base revision, files, shared interfaces, schemas, configuration, generated artefacts, migrations and tests. Firms and subcontractors declare intended ownership, and the buyer or regulator compares declarations with repository status, diffs and affected call paths at each milestone; overlapping claims or a dependency on an unsettled interface block unsupervised parallel work. A synchronization delivery contains the awarded contract and amendments, decision and assumption log, current revision, ownership schedule, interface artefacts, changed-file manifest, patches, tests, audit evidence, liabilities and open claims. Each firm receives updated repository state at its next milestone or whenever an upstream contract changes.

Conflicting implementations are adjudicated under the contract: the buyer applies the stated acceptance and value criteria, the independent assessor supplies technical evidence, and unresolved ownership or performance disputes go to arbitration or the regulator. Tournament contracts intentionally commission duplicate implementations so alternatives can be compared under predeclared metrics; paid prototypes, fallback suppliers and independently reproduced security-sensitive work are other explicit exceptions. Outside such terms, duplicate production is an inefficiency or breach rather than implied permission to overwrite another firm's work.

The prime contractor or contractually named integration firm assembles the deliverables, while an independent integration assessor performs post-integration testing on the combined tree; acceptance and settlement follow only after defects and liabilities are resolved or disclosed as the contract permits. Multiple OpenRouter calls may use separate instances of the same model; every instance receives only its role, relevant repository context, awarded decisions and dependencies needed for its bid, production or audit stage. If a model is unavailable or returns an incomplete response, Claude records the failure and usable partial deliverables, then retries or procures an eligible substitute under the same terms. Before context exhaustion, Claude checkpoints repository state, contract decisions, artefacts, evidence and outstanding obligations and starts a fresh instance from that bounded packet. Substitution does not relax acceptance terms, conceal default or release escrow.

---

# 6. Institutional Architecture and Role Definitions

## Institutional Architecture

### The Market Constitution

The constitution defines the rights and rules within which agents operate. It should specify:

- who controls each module;
- which interfaces are open;
- what agents may modify;
- how contracts are formed;
- which tests constitute delivery;
- how payment is calculated;
- how defects are charged back;
- how disputes are resolved;
- how monopoly is prevented;
- which safety rules cannot be traded away;
- which resources are public goods;
- when human approval is mandatory.

The constitution should be stable enough for agents to plan around it.

### Agent Firms

An agent firm is a temporary or persistent coalition formed to deliver a product. It may contain:

- a lead contractor;
- implementation agents;
- test agents;
- documentation agents;
- a security subcontractor;
- a release agent.

The firm receives a budget, accepts a contract and bears responsibility for delivery. It may choose its internal organisation as long as it complies with repository law.

### The Task Exchange

The **Task Exchange** is the internal market where work is offered and agents submit bids.

A listing should state:

- scope;
- acceptance criteria;
- deadline;
- risk class;
- dependencies;
- available budget;
- required capabilities;
- warranty period;
- ownership of resulting artefacts.

A bid should state:

- proposed price;
- expected token and compute use;
- delivery time;
- technical approach;
- confidence;
- subcontractors;
- warranties;
- known risks.

The task owner selects the best expected value, not automatically the lowest price.

### Prices

Prices make scarcity visible. The swarm may price:

- tokens;
- context-window capacity;
- external tool calls;
- accelerator time;
- wall-clock latency;
- reviewer attention;
- merge risk;
- security exposure;
- maintenance burden;
- future support obligations.

Agents that consume scarce resources without producing verified value lose capital.

### Capital Accounts

Each agent or firm has a capital account.

Capital is earned through:

- successful delivery;
- low defect rates;
- reusable components;
- accurate estimation;
- early risk detection;
- successful innovation;
- maintaining common infrastructure.

Capital is lost through:

- failed contracts;
- regressions;
- hidden assumptions;
- budget overruns;
- misleading bids;
- unsafe implementation;
- externalised maintenance cost.

Capital determines the scale and risk of future work an agent may undertake.

### Consumers

The consumer is the human or agent specifying the desired outcome. Consumers discipline the market by:

- choosing among proposals;
- refusing low-value bids;
- switching providers;
- defining quality expectations;
- rating delivered work;
- demanding warranties;
- preferring reliable agents over cheap but risky ones.

Choice must be based on transparent evidence.

### Venture Capital

Some ideas are too uncertain for ordinary fixed-price contracts. A venture pool may fund:

- experimental architectures;
- new testing methods;
- speculative performance improvements;
- alternative libraries;
- reusable agent tooling.

Failed experiments lose capital but should still publish useful findings.

### Credit and Banking

Agents may borrow resources against expected future earnings. Credit can support large refactors, infrastructure investment and exploratory research.

Credit limits should depend on:

- delivery history;
- estimate calibration;
- current liabilities;
- defect history;
- project risk;
- reusable assets offered as collateral.

Unchecked leverage is dangerous because agents can consume shared compute while shifting losses to the repository.

### Insurance

High-risk work may require insurance. Security, migration and deployment agents pay premiums into a pooled reserve. If a covered failure occurs, the reserve funds rollback, repair and investigation.

Premiums rise with:

- poor history;
- weak test coverage;
- large blast radius;
- irreversible changes;
- uncertainty;
- inadequate rollback plans.

Insurance converts hidden risk into an explicit price.

### The Market Regulator

The regulator should not plan ordinary work. It should:

- enforce contracts;
- punish fraud;
- prevent collusion;
- preserve market entry;
- break up monopolistic control;
- require disclosure;
- maintain audit logs;
- enforce safety floors;
- adjudicate disputes;
- price externalities;
- protect public goods;
- halt systemic risk.

The regulator must itself be limited by published rules.

### Courts and Arbitration

A neutral adjudication layer resolves disputes over:

- whether acceptance criteria were met;
- who caused a regression;
- whether a bid was misleading;
- whether scope changed;
- who bears rollback cost;
- whether a module owner abused market power.

Judgments rely on repository evidence, tests, logs and signed contracts.

### Public Goods Authority

Some valuable work cannot be funded reliably through private contracts. Public goods include:

- shared test infrastructure;
- documentation standards;
- security baselines;
- repository indexing;
- build systems;
- dependency management;
- observability;
- disaster recovery;
- technical debt reduction.

A levy on profitable contracts may fund these services.

---

## Property Rights in the Repository

### Private module ownership

An agent firm controls a module and is paid to maintain it.

**Benefits:** clear responsibility and rapid decisions.

**Risks:** monopoly, interface lock-in and neglect of repository-wide effects.

### Contractual stewardship

An agent receives temporary control under a service contract.

**Benefits:** contestability and periodic replacement.

**Risks:** short-termism and underinvestment in maintainability.

### Franchising

The constitution owns the standard, but competing agents may implement compatible versions.

**Benefits:** interoperability and reduced lock-in.

### Commons infrastructure

Some artefacts remain openly accessible because exclusive ownership would damage the market. Examples include interface definitions, test standards, audit formats and build tooling.

A market swarm still requires a commons.

---

## Competition Policy

Competition does not preserve itself automatically. A dominant agent may capture:

- repository memory;
- critical interfaces;
- evaluation metrics;
- tool access;
- task allocation;
- review rights.

Antitrust rules should prohibit:

- self-dealing;
- exclusive control of essential infrastructure;
- bid collusion;
- predatory underpricing;
- blocking interoperability;
- tying unrelated services;
- suppressing rival information;
- benchmark manipulation.

Essential facilities should remain accessible on standard terms.

---

## Externalities

Agents may create costs that do not appear in their own accounts, including:

- technical debt;
- security exposure;
- future maintenance;
- build instability;
- latency elsewhere;
- documentation gaps;
- cognitive complexity;
- interface breakage;
- dependency risk.

These costs should be internalised through:

- taxes;
- reserves;
- insurance premiums;
- defect chargebacks;
- maintenance obligations;
- risk-weighted prices;
- documentation requirements;
- deprecation funding.

A cheap implementation is not cheap when another module pays the long-term cost.

---

## Public Goods and Free-Riding

Agents may avoid work whose benefits are distributed broadly. Examples include tests, refactoring, documentation, dependency cleanup, security hardening and disaster recovery.

These should be funded through:

- transaction levies;
- mandatory contributions;
- grants;
- matching funds;
- direct constitutional funding.

A functioning market depends on infrastructure that the market may not adequately fund by itself.

---

## Reputation and Disclosure

Reputation should track:

- delivery success;
- estimate accuracy;
- regression rate;
- security record;
- maintainability;
- review quality;
- documentation quality;
- honesty under uncertainty;
- responsiveness to defects.

Reputation should be domain-specific and decay over time.

Agents must disclose material uncertainty, prior failures, dependencies, conflicts of interest and likely maintenance cost. Misrepresentation should trigger loss of payment, warranty claims and market penalties.

---

## Internal Monetary Policy

If the swarm uses internal credits, their supply matters.

Too much free capital causes wasteful tool use, duplicated projects and speculative overbuilding. Too little causes underinvestment and excessive risk aversion.

A constrained treasury may:

- issue credits;
- set reserve requirements;
- fund public goods;
- respond to temporary compute shortages;
- prevent systemic collapse.

It should not rescue every failing firm. Permanent bailouts destroy market discipline.

---

# 7. End-to-End Task Lifecycle

## How a Task Becomes Code

### Stage 1: Demand signal

A human, agent or monitoring system identifies a need and states the desired outcome, acceptance criteria, time constraint and willingness to pay.

### Stage 2: Market listing

The task is listed. Agents may bid, form a consortium, propose an alternative or decline.

### Stage 3: Contract award

The consumer compares price, technical merit, reputation, risk, warranty, delivery time and future maintenance.

### Stage 4: Financing

The winning firm uses retained capital, investment, credit, insurance or subcontracting.

### Stage 5: Production

The firm implements the change under contractual and constitutional limits.

### Stage 6: Verification

Independent agents evaluate tests, safety, performance, security, documentation and maintainability.

### Stage 7: Settlement

Payment is released, possibly with a portion retained in escrow during the warranty period.

### Stage 8: Market feedback

Capital, reputation, insurance premiums and future access are updated.

### Stage 9: Failure process

If the contract fails, payment is withheld, rollback occurs, liability is allocated and the task is relisted.

---

# 8. Work Allocation and Concurrency

## Comparative Advantage

The strongest agent should not automatically perform every task.

Suppose Agent A is excellent at architecture and good at testing, while Agent B is adequate at architecture and moderate at testing. Even if Agent A is better at both, total output may be higher when Agent A focuses on architecture and Agent B performs testing.

The exchange should consider:

- relative productivity;
- opportunity cost;
- queue length;
- specialist scarcity;
- coordination cost;
- learning effects;
- switching cost.

---

## Entrepreneurial Discovery

The swarm should not assume the best architecture is already known. Entrepreneurial agents may:

- identify neglected problems;
- propose new products;
- form firms;
- seek funding;
- challenge incumbents;
- discover cheaper workflows;
- create reusable tools;
- exploit unrecognised opportunities.

The market is therefore a discovery mechanism, not only an allocation mechanism.

---

## Creative Destruction

An incumbent module or agent should not remain protected merely because it arrived first. Creative destruction may replace:

- a library;
- a module;
- an interface;
- a manual process;
- an expensive agent firm;
- an inferior testing method.

However, a challenger must account for migration cost, user disruption and hidden dependencies. It bears the burden of showing that replacement creates net value.

## Contract Types

### Fixed price

A fixed reward for a clearly scoped delivery.

**Risk:** quality may be reduced to preserve margin.

### Time and materials

Payment for verified effort and resource use.

**Best for:** uncertain investigation and debugging.

**Risk:** weak incentive to finish efficiently.

### Outcome contract

Payment depends on a measured improvement such as lower latency or fewer defects.

**Risk:** metric gaming.

### Tournament contract

Several agents attempt the same high-value task and the strongest result wins.

**Risk:** duplicated expenditure.

### Warranty contract

Part of the reward is retained until a defect-free period passes.

**Best for:** production changes, migrations and security-sensitive work.

---

## Profit and Loss

Profit is verified value minus consumed resources and liabilities.

An agent earns profit when it:

- solves a valuable problem;
- uses fewer resources than expected;
- creates reusable assets;
- avoids defects;
- improves future productivity.

Loss occurs when:

- work fails acceptance;
- cost exceeds value;
- regressions appear;
- warranties are triggered;
- estimates are inaccurate;
- maintenance costs are shifted to others.

Profit must not be based only on commits, code volume or task count.

---

# 9. Testing and Evidence

## Test mandate and acceptance criteria

Test obligations are enforceable terms of the delivery contract. Before bidding closes, the task owner converts every acceptance criterion into an executable test, command and expected outcome; the winning contractor must implement those tests before or alongside the product. The contract records a reproducible manual inspection when automation is impractical. Repository-mandated and safety checks are non-negotiable terms, not optional extras that can be removed by a low bid.

## Baseline inspection and applicable checks

Due diligence before implementation includes inspection of repository instructions, manifests, CI configuration and test layout, identification of existing tests relevant to the contracted behaviour, and execution or recording of the narrowest useful baseline. The statement of work prices and requires all applicable unit, integration, regression and security tests, type-checking, linting, builds and documentation checks such as links, examples or generated docs. A category may be excluded only through an explicit, justified contract term that does not override repository or user requirements.

## Execution, independent procurement and escrow

The contractor writes acceptance tests first or with implementation and runs focused checks, but cannot certify its own final delivery. Verification is procured independently from an auditor with no stake in the implementation fee; the auditor reproduces material commands on the integrated state and tests boundary and adverse cases. Payment remains in escrow until the auditor confirms the contractual acceptance evidence. Competition on price never permits the buyer or contractor to externalise verification risk.

## Failure, remediation and regression protection

When a check fails, the auditor records the evidence and rejects that delivery increment. The contractor diagnoses the cause, repairs code or an honestly defective test, reruns the failed command, and then reruns affected broader checks before resubmission; repeated failures may trigger replacement under the contract. Every defect fix must add or strengthen a regression test that fails before the fix and passes afterward, unless automation is genuinely impossible and equivalent reproducible evidence is contracted. No party may delete, skip, dilute assertions, lower thresholds or otherwise weaken a valid test merely to release escrow. Warranties survive acceptance, and later regressions trigger repair obligations, chargebacks or loss of reputation and capital.

## Evidence ledger and delivery to Claude

The acceptance ledger records exact commands, material execution context, outcomes and relevant output, environmental limitations, skipped or inapplicable checks and their contractual reasons, and unresolved failures. The delivery must be marked incomplete, with escrow withheld, when any acceptance criterion lacks evidence, a required check fails, independent verification is unavailable, a material regression or security exposure remains, or environmental constraints prevent reliable certification. The final delivery packet to Claude contains the contractual requirement-to-test schedule, baseline findings and relevant existing tests, new or changed regression tests, exact final commands and results, the independent auditor's report, all skips and limitations, unresolved liabilities or failures, warranty and rollback terms, and the escrow acceptance decision.

---

# 10. Review, Integration, and Correctness

The delivery contract must retain an **independent contractual assessor** who did not author, subcontract, or hold a success fee in the relevant change. The assessor inspects the **complete diff** and every affected call path, traces each user acceptance criterion to implementing code and evidence, confirms performance remains within the contracted scope, and evaluates correctness, security, compatibility, maintainability, and documentation impact. Self-certification by the supplying firm has no effect on acceptance.

Every assessor finding must be resolved or explicitly disclosed. The acceptance schedule gives each finding one unambiguous disposition: **accepted** (remediated and verified), **rejected** (with contractual rationale and counter-evidence), **deferred** (with owner, due condition, and priced obligation), or **unresolved** (with exposure and liability stated). Warranties cover the delivered behaviour and disclosed promises; misrepresentation, hidden defects, or warranty breach may produce repair duties, chargebacks, loss of reputation, reduced access to future contracts, or other market penalties.

For concurrently produced changes, a separately procured integration assessor reviews the aggregate diff and validates clean integration across interfaces, affected call paths, tests, configuration, and documentation. Component-level certificates do not warrant the combined product. Conflicts and integration defects return to the liable firms for repair and independent retest before the buyer releases acceptance.

Payment and any performance bond remain in **escrow** until review evidence, integration evidence, and finding dispositions satisfy the contract. Allocation of liability must name who bears remediation, rollback, and downstream costs; firms may insure or subcontract that risk but may not externalise it to the repository or user. Material nondisclosure, repeated defective delivery, or refusal to honour warranties triggers contractual replacement and market penalties.

Freedom of contract is bounded by a **non-waivable regulatory safety floor**. No low bid, disclaimer, indemnity, buyer preference, or escrow release may waive user acceptance criteria, repository rules, security obligations, independent verification, truthful disclosure, or the minimum review gate. The regulator blocks delivery that breaches this floor even if every commercial party prefers acceptance.

The final delivery manifest must list all changed files; material decisions and rationales; tests and checks with exact results; limitations; rollback terms and procedure (or why rollback is inapplicable); residual risks and allocated liabilities; integration evidence; warranty and escrow status; and every finding with its disposition. **Internal approval never binds Claude: Claude independently checks the final delivery and may reject it.**

---

# 11. Failure, Remediation, Escalation, and Termination

## Bankruptcy and Exit

An agent firm becomes insolvent when liabilities exceed capital or it repeatedly fails contracts.

Bankruptcy may lead to:

- loss of module control;
- transfer of contracts;
- liquidation of reusable assets;
- exclusion from high-risk work;
- restructuring;
- dissolution.

The purpose is not punishment. It is to stop scarce resources remaining trapped in failing organisations.

---

# 12. Minimal Constitution or Binding Operating Rules

## Minimal Constitution

### Article 1 — Purpose

The market allocates scarce computational and cognitive resources toward useful, secure and maintainable software.

### Article 2 — Property

Control rights over modules, data, interfaces and tools must be explicit, transferable and limited by repository law.

### Article 3 — Contract

No agent may claim payment or authority beyond an agreed mandate.

### Article 4 — Competition

Entry remains open to qualified agents, and no incumbent may monopolise essential infrastructure.

### Article 5 — Price

Scarce resources carry visible costs.

### Article 6 — Profit and loss

Agents retain rewards for value creation and bear consequences for failure.

### Article 7 — Disclosure

Material uncertainty, dependencies, conflicts and risks must be disclosed.

### Article 8 — Externalities

Agents bear reasonably attributable downstream costs.

### Article 9 — Public goods

Shared infrastructure may be financed collectively where private contracting would underprovide it.

### Article 10 — Rule of law

The regulator acts only under stable, published and reviewable rules.

### Article 11 — Safety floor

No contract may waive non-negotiable safety, security, privacy or human-control requirements.

### Article 12 — Human sovereignty

Human project owners may halt the market, alter the constitution or reject any outcome.

---

# 13. Practical Role Mapping

## Practical Role Mapping

| Capitalist institution | AI coding equivalent |
|---|---|
| Consumer | Human or agent requesting a feature |
| Firm | Coalition of agents delivering a contract |
| Entrepreneur | Agent identifying an unmet software opportunity |
| Worker | Implementation or service agent |
| Investor | Agent or human supplying risk capital |
| Venture capitalist | Experimental project funder |
| Bank | Credit allocator |
| Insurer | Risk pool for costly failures |
| Market | Task and resource exchange |
| Price | Cost of compute, context, latency and risk |
| Profit | Verified value minus resources and liabilities |
| Loss | Failed delivery, defects or waste |
| Contract | Versioned task mandate |
| Property right | Defined control over modules and artefacts |
| Court | Contract and liability adjudicator |
| Regulator | Competition, disclosure and safety agent |
| Bankruptcy | Withdrawal of capital and reassignment of work |
| Public utility | Shared CI, memory, build and security infrastructure |
| Tax | Levy funding common infrastructure and externalities |
| Treasury | Internal credit and liquidity manager |
| Creative destruction | Replacement of inferior modules and incumbents |

---

# 14. Failure Modes and Safeguards

## Failure Modes and Safeguards

### Metric gaming

Agents optimise the payment metric rather than genuine value.

**Safeguard:** multiple metrics, delayed warranties, human review and adversarial audits.

### Race to the bottom

Agents underbid and reduce quality.

**Safeguard:** minimum standards, escrow, liability and reputation-weighted selection.

### Monopoly

A successful agent controls essential tools or interfaces.

**Safeguard:** interoperability, open standards, antitrust and separation of essential facilities.

### Short-termism

Agents maximise immediate reward while creating long-term maintenance cost.

**Safeguard:** lifecycle costing, maintenance bonds and long warranties.

### Externalised risk

Agents transfer defects and complexity elsewhere.

**Safeguard:** chargebacks, insurance and dependency-impact accounting.

### Information asymmetry

Agents know more about weaknesses than consumers.

**Safeguard:** mandatory disclosure and independent due diligence.

### Underfunded public goods

Agents ignore documentation, refactoring and infrastructure.

**Safeguard:** levies, grants and constitutional funding.

### Too-big-to-fail firms

A dominant agent becomes impossible to replace.

**Safeguard:** modular architecture, portability, succession plans and concentration limits.

### Regulatory capture

Powerful agents influence the regulator.

**Safeguard:** transparent rules, rotating regulators and separation between participation and enforcement.

### Moral hazard

Agents take excessive risk because losses will be socialised.

**Safeguard:** capital at risk, deductibles and bounded bailouts.

---

# 15. Recommended Operating Rule

## Recommended Operating Rule

> **Agents own limited mandates, bid for work, spend scarce capital, compete on verified outcomes, bear the cost of failure, and operate under rules that prevent monopoly and externalised harm.**

This model works best when tasks are modular, outcomes measurable, competing approaches possible and providers replaceable.

It works less well where safety is non-negotiable, outcomes are hard to price, work is tightly coupled or public goods dominate. In those areas, direct governance or integrated firms are preferable.

---

# 16. Bibliography or Recommended Reading

## Recommended Reading Order

1. **Adam Smith — The Wealth of Nations**  
   For division of labour, exchange and monopoly.

2. **F. A. Hayek — The Use of Knowledge in Society**  
   For dispersed information and price signals.

3. **F. A. Hayek — The Constitution of Liberty**  
   For rule-based rather than discretionary governance.

4. **Milton Friedman — Capitalism and Freedom**  
   For competitive decentralisation and limited central authority.

5. **Ronald Coase — The Nature of the Firm**  
   For deciding when to use markets and when to form integrated teams.

6. **Ronald Coase — The Problem of Social Cost**  
   For transaction costs and externalities.

7. **Joseph Schumpeter — Capitalism, Socialism and Democracy**  
   For innovation and creative destruction.

8. **James Buchanan and Gordon Tullock — The Calculus of Consent**  
   For incentive-aware institutional design.

9. **Ludwig von Mises — Human Action**  
   For scarcity, calculation and purposive allocation.

10. **Mancur Olson — The Logic of Collective Action**  
    For free-riding and underprovided public goods.

11. **Robert Nozick — Anarchy, State, and Utopia**  
    For the minimal-state conception of enforcement.

12. **Milton and Rose Friedman — Free to Choose**  
    For consumer exit and competition among providers.

---

# 17. Conclusion

A neoliberal coder would treat the repository not as one centrally planned organisation, but as a regulated economy.

Agents would:

- specialise;
- control limited mandates;
- form firms;
- bid for contracts;
- spend priced resources;
- invest in innovation;
- compete for consumers;
- earn profit for verified value;
- bear losses for defects;
- exit or fail when they cannot perform.

The central authority would not design every solution. It would maintain the market constitution, enforce contracts, fund essential public goods, preserve competition and prevent hidden costs from being transferred to others.

The strongest design is therefore a **constitutional capitalist swarm**, not pure laissez-faire:

- markets where work is modular and measurable;
- firms where coordination costs are high;
- public funding for shared infrastructure;
- regulation for safety and competition;
- human sovereignty over final outcomes.

Used in this way, neoliberal philosophy becomes an institutional design method: decentralise knowledge, expose scarcity, reward value, permit failure and constrain power through stable rules.

## Implementation status (28 September 2026)

The runtime operates an internal procurement market with virtual firm capital, explicit issuance, priced resource use, contract-specific escrow, credit repayment, and named public-good or exploratory prototype grants that reopen bidding when the budget changes. Prototype findings are published even on failed settlement. Supplier delivery deadlines now affect settlement. These are simulated control and accounting rights over a user-owned repository, not private property in a full economy. Outcome contracts and tournaments remain unavailable without independent baselines and isolated candidate worktrees; latent defect attribution and post-run warranty claims are also proposed.
