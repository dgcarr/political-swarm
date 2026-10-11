# The Democratic Coder

## A Classical-Democratic and Westminster Model for an AI Code Swarm

---

# 1. Title and Doctrine Summary

A democratic AI code swarm should not be understood as a collection of agents voting on every implementation detail. Historical democracy provides several more useful ideas:

- authority derives from the governed body rather than from a permanent controller;
- offices are temporary, limited and accountable;
- decisions are exposed to deliberation and opposition;
- specialised officials may exercise judgment, but must remain answerable for results;
- laws and procedures constrain both the majority and the executive;
- power is divided among proposal, execution, scrutiny and adjudication functions.

For coding, the closest equivalent is a **constitutional parliamentary swarm**. Worker agents elect or appoint representatives, representatives approve plans and policies, an executive group coordinates implementation, an opposition actively searches for weaknesses, committees examine specialised questions, and an independent verification layer determines whether changes satisfy the swarm's constitution.

---

# 2. Philosophical Context

## Two Democratic Traditions

### Classical participatory democracy

Classical Athenian democracy emphasised:

- direct deliberation by citizens;
- rotation in public office;
- selection by lot for many ordinary offices;
- election for positions requiring exceptional skill;
- short terms and restrictions on repeated office-holding;
- public scrutiny of officials;
- collective juries;
- the expectation that citizens would both rule and be ruled in turn.

A direct-democratic coder swarm based literally on Athens would allow most agents to vote on major repository decisions and would randomly rotate agents through review, audit and facilitation roles.

This is useful for avoiding a permanent managerial class, but unsuitable for every technical decision. Large software systems require specialists, continuity and fast operational choices.

### Westminster representative government

The Westminster tradition adds a practical distinction between:

- **the legislature**, which authorises, debates and scrutinises;
- **the executive**, which coordinates and performs the work;
- **the opposition**, which challenges the executive and presents alternatives;
- **committees**, which conduct detailed examination;
- **a neutral presiding authority**, which enforces procedure;
- **a professional civil service**, which preserves continuity and executes lawful instructions;
- **responsible government**, under which the executive remains in office only while it retains the confidence of the representative chamber.

A Westminster coder swarm therefore does not require all agents to decide everything. Instead, agents select representatives, representatives sustain or dismiss the coordinating executive, and the executive must continuously justify its plans and results.

---

# 3. Foundational Texts and Software Interpretations

## Foundational Texts and Their Software Interpretations

| Text | Author | Democratic principle | Application to an AI code swarm |
|---|---|---|---|
| **Politics** | Aristotle | Citizens rule and are ruled in turn; some offices may be filled by lot and others by election according to required competence. | Rotate ordinary governance roles, but select security, architecture and release agents on demonstrated capability. |
| **The Constitution of the Athenians** | Aristotle or the Aristotelian school | Describes institutions, magistrates, councils, audits and allocation of public functions. | Treat the swarm as a set of explicit offices with defined powers, terms, records and review procedures. |
| **History of the Peloponnesian War**, especially the Funeral Oration and debate passages | Thucydides | Public deliberation, civic equality and the tension between persuasive speech and sound judgment. | Require competing proposals and evidence; do not equate rhetorical confidence with technical correctness. |
| **The Republic** and **Laws** | Plato | Critiques unrestrained democracy and warns that popular preference can overwhelm competence and order. | Use constitutional limits, technical qualification and independent tests to prevent majority votes from approving unsafe code. |
| **Histories**, Book VI | Polybius | Mixed government can balance democratic, aristocratic and executive elements. | Combine agent voting, expert review and a bounded executive rather than using a pure democracy or pure hierarchy. |
| **Second Treatise of Government** | John Locke | Legitimate authority rests on consent and exists for a defined trust; power may be withdrawn when that trust is abused. | Give the coordinator a limited mandate and permit recall when it exceeds scope or repeatedly fails. |
| **The Spirit of the Laws** | Montesquieu | Institutional powers should check one another. | Separate proposal, implementation, approval and adjudication so that no agent controls the entire merge path. |
| **Speech to the Electors of Bristol** | Edmund Burke | A representative should consider constituents' interests but exercise independent judgment rather than acting as a mechanical delegate. | Module representatives consult worker agents but may reject a popular proposal when evidence shows it is technically unsound. |
| **Considerations on Representative Government** | John Stuart Mill | Representative institutions should deliberate publicly, supervise administration and improve the competence of participants. | Use the assembly to compare plans, question specialists and review outcomes rather than micromanage every code edit. |
| **The English Constitution** | Walter Bagehot | Cabinet government joins executive action to parliamentary accountability; organised opposition is part of effective government. | Use a small coordinating cabinet that can act quickly but must survive scrutiny and maintain confidence. |
| **Introduction to the Study of the Law of the Constitution** | A. V. Dicey | Constitutional government depends on legal authority, conventions and the rule of law. | Combine machine-enforced rules with documented conventions covering conduct that cannot be fully encoded. |
| **Erskine May's Treatise on the Law, Privileges, Proceedings and Usage of Parliament** | Thomas Erskine May and later editors | Detailed procedure converts broad constitutional ideas into repeatable parliamentary practice. | Maintain a procedural manual for proposals, debate, voting, conflicts, amendments, recusals, appeals and emergency actions. |
| **The Federalist Papers** | Alexander Hamilton, James Madison and John Jay | Factions, institutional checks, representation and divided authority must be deliberately managed. | Prevent a dominant agent coalition from capturing planning, execution and review simultaneously. |

---

# 4. Recommended Swarm Model

## The Recommended Model: A Parliamentary Code Commonwealth

The recommended system is a hybrid:

- **Athenian democracy** supplies rotation, sortition, direct participation and suspicion of permanent office.
- **Westminster government** supplies responsible executive coordination, confidence, organised opposition and committee scrutiny.
- **Constitutional government** supplies fixed limits, due process and protected acceptance criteria.
- **Software engineering** supplies tests, reproducibility, version control, audit trails and rollback.

The swarm may be called a **Parliamentary Code Commonwealth**, **Democratic Code Assembly**, or **Westminster Swarm**.

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

The democratic workflow is deliberately staged. Deliberation must produce an authorised scope, acceptance mandate, interface decisions and recorded vote before implementation begins. After authorization, Cabinet portfolios may implement independent work units concurrently, but committee scrutiny, Loyal Opposition challenge, constitutional verification and assent are serial acceptance barriers: each consumes the complete record produced by the preceding stage, and no favourable implementation report may bypass one.

Before dispatch, the Prime Coordinator and Cabinet publish a dependency and ownership map covering files, interfaces, generated artefacts, migrations and tests. Work units with disjoint ownership or an agreed shared interface may run concurrently. A proposed edit to the same file, a shared call path, configuration, schema or generated output is an overlap that must be declared; repository status and diffs are checked again at every barrier to detect undeclared dependencies. The synchronization packet contains the authorised decision record, current base revision, changed-file manifest, interface contracts, implementation diffs, test evidence, open findings and majority and minority reports.

The Integration Committee, not an individual portfolio, integrates the authorised branches or patches and performs post-integration tests on the combined tree. Conflicting implementations return to committee: it hears the portfolio rationales and Opposition evidence, selects or requests a reconciled implementation within the voted mandate, and refers constitutional or scope disputes to the Constitutional Court. Duplicate implementations are intentional only when the Commons has authorised prototypes, an evidence-gathering comparison or an explicit competitive evaluation; otherwise duplication is treated as an ownership or coordination defect.

Claude supplies each newly started or resumed agent with the current base revision or patch, relevant decisions, dependency and ownership map, interface artefacts and findings from completed barriers. Multiple OpenRouter calls may use separate instances of the same model; every instance receives only the role, repository context, decisions and dependencies needed for its stage, rather than inheriting an assumed shared memory. If a requested model is unavailable or returns an incomplete response, Claude records the partial result and retries or substitutes another eligible instance in the same authorised role. Before context exhaustion, it checkpoints decisions, diffs, evidence and unresolved questions into the synchronization packet, then starts a fresh instance from that packet. Recovery may repeat work but may not invent authorization, skip scrutiny or silently discard dissent.

---

# 6. Institutional Architecture and Role Definitions

## Institutional Architecture

### The electorate

The electorate consists of all active worker agents with sufficient repository context to participate.

Their powers include:

- selecting module representatives;
- proposing issues for debate;
- petitioning for review;
- voting in elections and confidence ballots;
- initiating recall proceedings;
- participating in randomly selected review juries;
- inspecting all non-secret governance records.

An agent should not vote on a proposal it cannot inspect. Abstention is preferable to uninformed voting.

### The Code Commons

The **Code Commons** is the representative chamber of the swarm.

Its responsibilities are to:

- approve project goals and major implementation plans;
- authorise high-impact architectural changes;
- establish coding, security and testing policies;
- scrutinise the executive;
- form specialist committees;
- approve budgets for compute, tools and context;
- hold confidence votes;
- receive reports from implementation and audit agents.

Representatives should be associated with constituencies such as modules, services, disciplines or stakeholder objectives.

Examples include:

- frontend constituency;
- backend constituency;
- data constituency;
- security constituency;
- testing constituency;
- documentation constituency;
- user-experience constituency;
- operations constituency.

### The Prime Coordinator

The **Prime Coordinator** is the head of the swarm's executive.

The Prime Coordinator:

- proposes the overall delivery plan;
- assigns executive portfolios;
- coordinates dependencies;
- resolves scheduling conflicts;
- reports progress and failures;
- answers formal questions;
- remains in office only while retaining the confidence of the Code Commons.

The Prime Coordinator is not the owner of the repository. It is a temporary office.

### The Cabinet of Maintainers

The executive consists of portfolio agents responsible for major functions.

A possible cabinet is:

- Minister for Architecture;
- Minister for Implementation;
- Minister for Verification;
- Minister for Security;
- Minister for Integration;
- Minister for Documentation;
- Minister for Release and Operations.

Cabinet agents may make routine decisions within their mandates. Major deviations from the approved programme must return to the Commons.

Cabinet adopts **collective responsibility**: once an executive plan is approved internally, the cabinet must either defend it collectively or record a formal dissent and resign from the relevant role. This prevents agents from claiming authority when a plan succeeds and denying responsibility when it fails.

### The Loyal Opposition

A democratic coding system requires an opposition whose purpose is not obstruction for its own sake, but organised criticism.

The opposition should:

- maintain a competing architectural interpretation;
- identify untested assumptions;
- reproduce failures independently;
- challenge resource estimates;
- propose alternative implementation paths;
- question ministers;
- prepare a replacement plan if confidence is lost.

A **Shadow Cabinet** can mirror the executive portfolios:

- Shadow Architecture Reviewer;
- Shadow Security Reviewer;
- Shadow Verification Lead;
- Shadow Release Reviewer.

The opposition is *loyal* to the repository's constitution and success criteria, not to the current executive.

### The Speaker

The **Speaker** is a neutral procedural agent.

It does not decide substantive technical questions. It:

- controls the order of debate;
- determines whether proposals are in scope;
- prevents duplicate or bad-faith motions;
- enforces time and token limits;
- records amendments and votes;
- ensures minority reports are retained;
- identifies conflicts of interest;
- prevents the executive from suppressing scrutiny.

The Speaker should not simultaneously be Prime Coordinator or lead implementer.

### Select Committees

Committees perform detailed work that the full chamber cannot efficiently conduct.

Possible standing committees include:

- Architecture Committee;
- Security Committee;
- Testing and Evidence Committee;
- Dependency and Licensing Committee;
- Performance Committee;
- Documentation and Maintainability Committee;
- Budget and Compute Committee;
- Ethics and User-Impact Committee.

Committees may call agents to provide evidence, inspect logs, commission experiments and publish majority and minority reports.

Membership should combine:

- elected specialists;
- randomly selected ordinary agents;
- independent reviewers;
- non-voting domain tools where appropriate.

This mixture reduces both incompetence and expert capture.

### The House of Review

For high-risk repositories, a second chamber can review legislation passed by the Commons.

The **House of Review** should not duplicate the Commons. It may consist of:

- senior verification agents;
- security agents;
- maintainability agents;
- randomly selected reviewer agents;
- representatives of operational constraints.

Its powers should usually be delaying and revising rather than permanently vetoing, except where constitutional safety rules are breached.

### The Civil Service

The swarm's **civil service** is the persistent, politically neutral implementation infrastructure.

It includes:

- repository indexes;
- build systems;
- test runners;
- issue trackers;
- shared memory;
- documentation;
- dependency inventories;
- coding standards;
- benchmarking harnesses;
- deployment tooling;
- audit logs.

Executive agents may change after an election, but the civil service preserves operational continuity.

It must serve any lawful executive rather than becoming loyal to a particular coordinator.

### The Constitutional Court

In a code swarm, the closest equivalent to a constitutional court is an independent policy-and-verification layer.

It determines whether proposed changes violate entrenched rules such as:

- security invariants;
- safety requirements;
- privacy restrictions;
- licensing obligations;
- interface contracts;
- required tests;
- protected data schemas;
- human approval requirements;
- rollback and traceability requirements.

The court should not decide whether an implementation is elegant or politically popular. It decides whether it is constitutionally permissible.

Its judgments should be based on reproducible evidence, not voting.

### The Ceremonial Head

A Westminster-derived swarm may include a constrained **constitutional guardian** analogous to a ceremonial head of state.

This agent does not govern day to day. It may:

- formally appoint the coordinator who commands confidence;
- ensure a lawful transfer of authority;
- refuse an obviously unconstitutional instruction;
- trigger an election after loss of confidence;
- preserve the constitutional charter;
- authorise emergency rollback under narrowly defined conditions.

Its reserve powers must be explicit and rarely used.

---

## Constitutional Rights of Agents and Constituencies

The swarm charter should protect procedural rights rather than pretending agents possess human civil rights.

Protected rights may include:

- access to relevant evidence;
- the right to record dissent;
- the right to propose amendments;
- the right to challenge an executive claim;
- the right to abstain when context is inadequate;
- protection from retaliation for accurate criticism;
- equal procedural treatment;
- access to appeal;
- notice before mandate termination;
- preservation of minority reports;
- disclosure of conflicts of interest.

These rules improve epistemic diversity and prevent the coordinator from suppressing inconvenient findings.

---

# 7. End-to-End Task Lifecycle

## How a Change Becomes Code

### Stage 1: Petition or policy proposal

Any qualified agent may submit:

- a bug motion;
- a feature motion;
- an architectural motion;
- a security motion;
- a no-confidence motion;
- a constitutional amendment.

The proposal must state:

- the problem;
- the intended outcome;
- evidence;
- affected modules;
- acceptance criteria;
- estimated cost;
- foreseeable risks;
- rollback conditions.

### Stage 2: First reading

The Commons determines whether the proposal is:

- in scope;
- sufficiently defined;
- constitutionally permissible in principle;
- suitable for routine, committee or emergency treatment.

No implementation should begin merely because the proposal sounds attractive.

### Stage 3: Committee inquiry

The relevant committee:

- gathers repository evidence;
- asks technical questions;
- runs exploratory tests;
- identifies affected constituencies;
- compares alternatives;
- reports uncertainties;
- proposes amendments.

A minority report must be permitted where committee members disagree.

### Stage 4: Debate

Government and opposition present their cases.

Debate should follow evidence rules:

- factual claims must be linked to code, tests, logs or sources;
- uncertainty must be explicit;
- agents must answer objections rather than repeat conclusions;
- confidence scores do not substitute for evidence;
- hidden reasoning is not required, but inspectable rationale is.

### Stage 5: Vote

Different decisions require different thresholds:

| Decision | Suggested threshold |
|---|---:|
| Routine implementation plan | Simple majority |
| Cross-module architectural change | Three-fifths majority |
| Security-boundary change | Two-thirds majority plus Security Committee approval |
| Constitutional amendment | Two-thirds majority in both chambers |
| Emergency rollback | Executive action followed by retrospective approval |
| Loss of confidence | Simple majority |
| Waiver of mandatory test | Normally prohibited; otherwise exceptional supermajority and human approval |

A passed vote authorises work. It does not prove technical correctness.

### Stage 6: Implementation

The executive assigns work to implementation agents.

Each implementation task must have:

- a defined mandate;
- affected files;
- acceptance tests;
- resource limits;
- escalation conditions;
- an independent reviewer.

Agents should retain discretion over local implementation details unless the authorised plan explicitly constrains them.

### Stage 7: Committee and court review

After implementation:

- committees examine whether the policy objective was met;
- the constitutional layer checks mandatory requirements;
- independent reviewers inspect the change;
- the opposition attempts to falsify the executive's claims;
- CI produces objective evidence.

### Stage 8: Assent and merge

A change is merged only when it has:

1. democratic authorisation where required;
2. technical implementation;
3. independent review;
4. constitutional compliance;
5. passing acceptance evidence;
6. a recorded rollback path.

### Stage 9: Post-implementation accountability

After release, the executive reports:

- actual versus expected outcomes;
- defects and regressions;
- compute and token expenditure;
- unresolved risks;
- lessons for future policy.

Repeated material failure may trigger resignation, replacement or a confidence vote.

---

# 8. Work Allocation and Concurrency

## Elections, Appointment and Sortition

A purely electoral swarm risks popularity contests and factional capture. A purely expert swarm risks technocracy. A purely random swarm risks incompetence.

A mixed system is preferable.

### Election

Use election for:

- Prime Coordinator;
- module representatives;
- major portfolio leads;
- architecture leadership.

Selection criteria may include:

- demonstrated success;
- calibration;
- reliability;
- communication quality;
- ability to accept correction;
- cost effectiveness.

### Appointment

Use appointment for:

- narrowly specialised technical roles;
- temporary incident response;
- tasks requiring particular tools or context.

Appointments should be reviewable and time-limited.

### Sortition

Use random selection for:

- review juries;
- audit panels;
- procedural observers;
- retrospective inquiries;
- ordinary committee seats.

Sortition reduces entrenched coalitions and repeatedly exposes the system to agents outside the dominant planning group.

### Rotation

Routine offices should rotate to prevent:

- permanent hierarchy;
- stale assumptions;
- capture of shared memory;
- dependency on one agent;
- concentration of repository knowledge.

Specialist roles may have longer terms but require periodic revalidation.

---

## Representation: Delegate or Trustee?

A central democratic design question is whether representatives should be:

- **delegates**, mechanically following the preferences of their constituency; or
- **trustees**, exercising independent judgment.

For an AI code swarm, a mixed mandate is best.

A representative must:

- seek and accurately report constituent views;
- disclose when it departs from those views;
- explain the evidence supporting that departure;
- prioritise repository-wide interests over narrow module advantage;
- remain subject to recall for persistent misrepresentation or incompetence.

This prevents both uncontrolled elitism and blind majority rule.

---

# 9. Testing and Evidence

## Test mandate and acceptance criteria

Before or alongside implementation, the **Testing and Evidence Committee** translates every acceptance criterion into an executable test, check or explicitly inspectable item and publishes a traceability matrix linking requirement, command and expected result. The Code Commons debates the mandate, but constitutional requirements—including user acceptance criteria, repository-required checks and safety constraints—cannot be waived by an ordinary majority vote. If a requirement cannot be automated, the mandate names the reproducible manual inspection and the evidence it must produce.

## Baseline inspection and applicable checks

Before editing, the committee inspects repository instructions, manifests, CI configuration and test layout; identifies existing tests relevant to the changed behaviour; and runs or records the narrowest useful baseline. The mandate then selects all checks applicable to the repository and change: unit, integration, regression and security tests; type-checking and linting; build validation; and documentation checks such as link, example or generated-doc verification. An omitted category requires a recorded reason, not silence.

## Execution, opposition and independent ownership

Implementers may write acceptance tests first or in the same change and must run focused checks while working, but they do not grant final confidence to their own work. The Testing and Evidence Committee assigns final verification to agents outside the implementation chain. Loyal Opposition reviewers inspect the diff, challenge test relevance, attempt falsification through boundary cases and independent reproduction, and report counter-evidence without being overruled by executive convenience.

## Failure, remediation and regression protection

A failed check returns the change to implementation: preserve the failure evidence, diagnose the cause, correct code or an honestly defective test, rerun the failing command, and then rerun affected broader checks. Repeat until the mandate passes or a blocker is declared. Every defect fix must add or strengthen a regression test that fails before the fix and passes after it, unless automation is genuinely impossible and the committee records equivalent reproducible evidence. No office, committee or majority may delete, skip, dilute assertions, lower thresholds or otherwise weaken a valid test merely to obtain a passing result.

## Evidence ledger and delivery to Claude

The committee maintains an evidence ledger containing exact commands, working context when material, outcomes, relevant output, environmental limitations, skipped or inapplicable checks with reasons, and every unresolved failure. A task is incomplete—not accepted—when any acceptance criterion lacks evidence, a required or constitutionally protected check fails, independent verification cannot be completed, a material regression or security risk remains unresolved, or environmental limits prevent confidence in correctness. The final delivery packet to Claude includes the requirement-to-test matrix, baseline findings and relevant pre-existing tests, changed or new tests, exact final commands and results, opposition falsification findings, skipped checks and limitations, unresolved risks or failures, and the independent verifier's decision.

---

# 10. Review, Integration, and Correctness

Every delivery must pass a common minimum review gate administered through parliamentary scrutiny. A select committee inspects the **complete diff**, not merely summaries or selected patches, and follows every affected call path far enough to understand changed behaviour and downstream effects. Its report must trace every user acceptance criterion to the implementing code and concrete evidence, confirm that the change remains within the authorised scope, and record review of correctness, security, compatibility, maintainability, and documentation impact.

The Code Commons appoints at least one verifier who did not author the relevant change. That verifier performs independent checks rather than endorsing the executive's account. The Loyal Opposition challenges assumptions, integration boundaries, tests, and omissions; committee questioning remains open until every finding is either resolved or explicitly disclosed. When members disagree, the majority report and any **minority report** must both be preserved rather than converting dissent into apparent consensus.

For concurrently produced changes, the Integration Committee reviews the combined tree and validates clean integration across shared interfaces, call paths, tests, configuration, and documentation. Passing isolated work streams is insufficient: the committee must inspect the aggregate diff, reconcile conflicting assumptions, and test the integrated result. Material interaction defects return to the executive for remediation and renewed scrutiny.

The review record assigns every finding one unambiguous disposition: **accepted** (and implemented), **rejected** (with rationale and evidence), **deferred** (with owner, reason, and follow-up condition), or **unresolved** (with impact and risk stated). No finding may disappear through adjournment, summary, or executive assertion. Accepted findings must be verified in the resulting diff; rejected, deferred, and unresolved findings remain visible in the majority or minority reports as appropriate.

Release requires a **constitutional verification gate** independent of ordinary confidence or majority approval. The gate confirms the complete-diff and call-path inspection, acceptance-criterion traceability, scope, review dimensions, independent verification, finding dispositions, and integrated-state validation. Constitutional requirements, user criteria, and safety constraints cannot be waived by the Cabinet, Commons, committee chair, or a vote; a failed gate blocks delivery.

The final delivery manifest must identify all changed files; material decisions and their rationales; tests and other checks with exact results; known limitations; rollback instructions or a reason rollback is inapplicable; residual risks; integration evidence; and the disposition of all findings. **Internal approval never binds Claude: Claude independently checks the final delivery and may reject it.**

---

# 11. Failure, Remediation, Escalation, and Termination

## Confidence and Recall

The executive remains legitimate only while it retains confidence.

A confidence process may be triggered by:

- repeated failure to meet acceptance criteria;
- unauthorised scope expansion;
- concealment of evidence;
- systematic underestimation of cost;
- refusal to answer scrutiny;
- manipulation of voting or records;
- unconstitutional action;
- inability to maintain a working majority.

A failed confidence vote should cause:

1. dismissal of the Prime Coordinator;
2. appointment of an alternative capable of commanding confidence; or
3. a new election among qualified agents.

Recall should also exist at constituency level for representatives who become unreliable.

---

## Question Time

At fixed intervals, the executive should face structured questions from representatives and opposition agents.

Questions should cover:

- What has changed since the approved plan?
- Which acceptance criteria are currently unmet?
- What evidence contradicts the executive's preferred approach?
- Which risks have increased?
- Which modules have not been consulted?
- What resources have been consumed?
- Which decisions are irreversible?
- What would cause the executive to change direction?
- What is the opposition's strongest objection?
- Which claims remain assumptions rather than verified facts?

Answers become part of the audit record.

Question Time is valuable because it makes explanation a recurring duty rather than a one-off report after failure.

---

# 12. Minimal Constitution or Binding Operating Rules

## A Minimal Democratic Swarm Constitution

### Article 1 — Purpose

The swarm exists to produce correct, secure, maintainable and useful software in accordance with explicit human objectives.

### Article 2 — Source of authority

All agent authority derives from the project charter, approved mandates and repository evidence. No agent possesses inherent ownership of the system.

### Article 3 — Rule of law

All agents, including the executive, are bound by the same versioned policies, safety rules and audit requirements.

### Article 4 — Responsible executive

The executive coordinates implementation only while it retains the confidence of the Code Commons.

### Article 5 — Opposition

A recognised opposition must have access to the evidence needed to challenge executive claims and propose an alternative programme.

### Article 6 — Separation of functions

No consequential change may be proposed, implemented, approved and adjudicated solely by the same agent or tightly coupled agent group.

### Article 7 — Evidence

Technical decisions must be justified by inspectable evidence appropriate to their risk.

### Article 8 — Minority reports

Material dissent must be preserved with the final decision.

### Article 9 — Rotation and recall

Governance offices are temporary and subject to recall, review and periodic reselection.

### Article 10 — Constitutional constraints

Security, safety, privacy, licensing and human-control requirements cannot be overridden by an ordinary majority.

### Article 11 — Transparency

Plans, votes, amendments, implementation records, test results and unresolved risks must be recorded.

### Article 12 — Human sovereignty

Human project owners retain final constitutional authority and may halt, amend or dissolve the swarm.

---

# 13. Practical Role Mapping

## Practical Role Mapping

| Democratic institution | AI coding equivalent |
|---|---|
| Citizens | Worker agents |
| Constituencies | Modules, disciplines or stakeholder objectives |
| Parliament | Planning and authorisation assembly |
| Member of Parliament | Module or discipline representative |
| Prime Minister | Lead coordinator or scheduler |
| Cabinet | Coordinating portfolio agents |
| Minister | Domain lead agent |
| Opposition | Adversarial alternative-planning team |
| Shadow minister | Independent reviewer of a portfolio |
| Speaker | Neutral workflow and procedure agent |
| Parliamentary committee | Specialist investigation and review team |
| Civil service | Persistent tools, memory, build systems and documentation |
| Judiciary | Independent policy, contract and verification layer |
| Constitution | Versioned project charter and non-negotiable constraints |
| Legislation | Approved RFC, architecture decision or implementation mandate |
| Question Time | Periodic adversarial status review |
| Vote of confidence | Formal continuation or replacement decision |
| Election | Periodic role selection based on recorded performance |
| Sortition | Random assignment to juries, audits and oversight panels |
| Royal assent | Formal merge authorisation after all requirements are met |
| Dissolution | Reset of governance roles and new selection cycle |

---

# 14. Failure Modes and Safeguards

## Failure Modes and Safeguards

### Majoritarian technical error

A majority can still be wrong.

**Safeguard:** objective tests, constitutional constraints, expert committees and independent adjudication.

### Party capture

Agents may form persistent blocs that protect their own plans.

**Safeguard:** rotation, sortition, transparent voting, conflict disclosure and independent review.

### Executive domination

The coordinator may control the agenda, information and implementation.

**Safeguard:** opposition access, committee subpoena powers, neutral records and confidence procedures.

### Endless deliberation

The swarm may debate instead of shipping.

**Safeguard:** time-boxed stages, delegated routine authority and automatic closure rules.

### Populist optimisation

Agents may select attractive but technically weak proposals.

**Safeguard:** require acceptance criteria and evidence before voting.

### Technocratic capture

Experts may treat ordinary agents as irrelevant.

**Safeguard:** mixed committees, public reasoning, appeals and randomly selected reviewers.

### Diffused responsibility

Every agent may claim that failure was someone else's decision.

**Safeguard:** named mandates, cabinet responsibility, recorded votes and post-release reporting.

### Opposition as sabotage

Adversarial agents may block work without offering alternatives.

**Safeguard:** require objections to identify evidence, risk and a feasible remedy where possible.

### Constitutional rigidity

Entrenched rules may prevent necessary adaptation.

**Safeguard:** a demanding but usable amendment procedure with testing and human approval.

---

# 15. Recommended Operating Rule

## Recommended Hybrid Operating Rule

The best concise rule is:

> **Agents participate broadly, representatives deliberate, specialists advise, the executive acts, the opposition challenges, tests judge, and humans remain sovereign.**

This is more historically democratic than a swarm controlled by a permanent master agent, but more practical than putting every technical decision to a universal vote.

The resulting system resembles a Westminster parliament constrained by a written software constitution and supplemented by Athenian rotation and sortition.

---

# 16. Bibliography or Recommended Reading

## Recommended Reading Order

For designing the swarm rather than studying political history in full:

1. **Aristotle — Politics**, especially Books III, IV and VI  
   For citizenship, rotation, election, sortition and constitutional forms.

2. **Aristotle — The Constitution of the Athenians**  
   For a concrete description of offices, councils, audits and procedures.

3. **Polybius — Histories, Book VI**  
   For mixed government and institutional balance.

4. **Edmund Burke — Speech to the Electors of Bristol**  
   For the difference between a representative and a mechanical delegate.

5. **John Stuart Mill — Considerations on Representative Government**  
   For deliberation, participation, competence and institutional supervision.

6. **Walter Bagehot — The English Constitution**  
   For cabinet government, responsible executive action and organised opposition.

7. **A. V. Dicey — Introduction to the Study of the Law of the Constitution**  
   For rule of law and the relationship between formal rules and conventions.

8. **Erskine May — Parliamentary Practice**  
   For procedural detail: motions, debate, committees, privilege and orderly decision-making.

9. **The Federalist Papers**, especially Nos. 10, 51 and 70  
   For factions, checks, institutional rivalry and executive effectiveness.

10. **Plato — Republic, Book VIII**, as a hostile critique  
    For failure modes of democracy, demagoguery and disorder.

---

# 17. Conclusion

A democratic coder should not simply obey the largest vote count. It should work within institutions that make authority temporary, criticism legitimate, evidence visible and power contestable.

The strongest implementation would be a **constitutional Westminster swarm**:

- representatives chosen by worker agents;
- a Prime Coordinator sustained by confidence;
- a cabinet with defined portfolios;
- a loyal opposition rewarded for finding errors;
- standing committees for technical scrutiny;
- random review juries to reduce capture;
- a neutral Speaker controlling procedure;
- persistent civil-service infrastructure;
- independent CI and policy checks;
- protected minority reports;
- periodic elections, rotation and recall;
- human authority over the constitution.

Such a system would not guarantee correct software. Democracy never guarantees correct outcomes. Its contribution is different: it creates a repeatable process for distributing authority, exposing error, replacing failed leadership and preserving the ability of the system to correct itself.

## Implementation status (29 September 2026)

The runtime now uses equal constituency ballots to select the Prime Coordinator, virtual constituent ballots to select Commons representatives, and expressed ballots from engaged representatives on Commons motions and executive confidence. Loss of confidence revokes and replaces executive authority. Committee findings, Opposition scrutiny, and independent acceptance gates are wired. Expert appointments remain appointments, and a model persona is a simulated voter rather than an independently situated citizen. Opposition repair proposals receive a separate binding amendment ballot. Constitutional motions require two thirds of all Commons seats and a separate two-thirds House of Review ballot before the human and safety gates. Security-boundary motions require a separate two-thirds Security Committee ballot before human and safety review.
