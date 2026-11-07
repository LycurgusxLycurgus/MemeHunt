---
name: requisite-complexity
description: Keeps software solutions matched to their problem, with no missing essential handling and no self-justifying machinery. Use when designing, implementing, debugging or reviewing code, prompts, schemas or tests, and whenever asked for a Requisite Complexity review.
---

# Requisite Complexity

A system should be exactly as complex as its problem requires: no more and no less. This document sets out one principle, the corollary that governs verification, and the laws derived from them. It applies equally to a demo and to a production system. What changes between the two is the evidence the problem supplies, not the rules.

Agents, LLMs included, tend to add a mechanism whenever something fails and rarely remove one. So the usual failure in practice is excess. The correction is still not "delete". It is "trace": keep what the problem requires, add what it requires and is missing, and remove everything else.

---

## 1. Foundation

### 1.1 The Principle: every mechanism answers to the problem

> **Every mechanism must be justified by the problem, never by another mechanism.**

A *mechanism* is any element of the solution that consumes attention or resources, or can fail.

**The trace test.** For any mechanism, ask: *what in the problem requires this?*

| Valid answers (trace to the problem) | Invalid answers (trace back into the system) |
|---|---|
| A stated requirement of the user or operator | Another mechanism of the system needs it |
| A real input or condition that has been observed | An earlier fix or design choice needs it |
| A known property of the domain, even if not yet observed | The system's own verification needs it |
| A constraint backed by evidence | It might happen: a risk with no evidence and no basis in the domain |

The test works in both directions:

- **Too little:** something the domain actually varies on has no handling in the system. The problem requires something that is missing, so you add it.
- **Too much:** a mechanism's only justification points back into the system. Nothing in the problem requires it, so you remove it, along with whatever made it seem necessary.

**How spirals form.** A failure is patched with a mechanism whose justification is an earlier design choice rather than the problem. The patch adds new failure surface. The next failure is patched in the same way, and the justifications form a chain that never reaches the problem. Every step seems reasonable on its own, but the system gradually becomes about itself. The warning sign is a fix whose justification cites an earlier fix.

**Where this comes from:**

- **Fred Brooks.** Magnum opus: *The Mythical Man-Month* (1975). Key essay: *No Silver Bullet: Essence and Accident in Software Engineering* (1986). Brooks split software complexity into **essential** complexity, which belongs to the problem and cannot be removed without changing what is solved, and **accidental** complexity, which comes from how we chose to solve it. Only accidental complexity can be removed, and engineering judgment consists of telling the two apart.
- **Ben Moseley and Peter Marks.** *Out of the Tar Pit* (2006). They extended Brooks by identifying the main sources of accidental complexity: **state** and **control**, meaning stored data and orchestration the problem does not demand. Their prescription is to keep essential logic pure, keep essential state minimal, and isolate everything accidental so it can be inspected and removed.
- **W. Ross Ashby.** *An Introduction to Cybernetics* (1956). The **Law of Requisite Variety** says a regulator can only control the disturbances it has states to respond to, or more briefly, only variety can absorb variety. A system with fewer distinctions than its environment fails on real inputs. This is the "no less" half of the principle, and the source of this document's name. The variety that is *requisite* is the environment's variety, not the system's own.

Brooks and Moseley and Marks set the upper bound: nothing accidental. Ashby sets the lower bound: everything the environment actually varies on.

### 1.2 The Corollary: reality is the only judge

> **A solution is correct only when real inputs from the problem show that it works. Evidence the system produces about itself is not proof.**

This is the principle applied to verification. Evidence also has to trace to the problem. If the inputs, the expected results or the judge of a check were produced by the system or its authors, the evidence traces back into the system. It can be a useful signal, but it does not show that the problem is solved.

The corollary has three working consequences:

1. **Grow from a simple system that works on real input.** Get a thin end-to-end path running against real inputs before adding depth. Each addition should be justified by what real runs reveal.
2. **Do not fool yourself.** A test you designed, passing on data you designed, confirms your own expectations. Real input is the test that can disagree with you.
3. **Do not turn a measure into a goal.** Any count, rate or pass/fail signal is a measure of the outcome, not the outcome itself. Once a measure becomes a target, the system gets optimized to produce the measure instead of solving the problem. A measure is only valid while it tracks the real outcome.

**Where this comes from:**

- **John Gall.** *Systemantics* (1975; later *The Systems Bible*). **Gall's Law:** every complex system that works evolved from a simple system that worked. A complex system designed from scratch never works and cannot be patched into working. You have to restart from a simple system that works.
- **Richard Feynman.** Magnum opus: *The Feynman Lectures on Physics* (1963–65). Key texts: the *Cargo Cult Science* commencement address (Caltech, 1974) and his appendix to the Rogers Commission report on the Challenger disaster (1986). In *Cargo Cult Science*, he warns that the first duty is not to fool yourself, and that you are the easiest person to fool. The Challenger appendix ends with the observation that "nature cannot be fooled." A procedure that has the form of verification but never confronts reality is cargo cult.
- **Charles Goodhart.** *Problems of Monetary Management: The U.K. Experience* (1975). **Goodhart's Law:** a statistical regularity breaks down once it is used for control. Anthropologist Marilyn Strathern later generalized it (1997): when a measure becomes a target, it stops being a good measure.

### 1.3 The two tests every decision must pass

1. **Trace test (Principle):** what in the problem requires this mechanism? If the answer points inward, remove it. If the problem requires something that is missing, add it.
2. **Reality test (Corollary):** what real input showed that this works? If the only evidence was produced by the system about itself, the work is not done.

Every law in this document applies these two tests to a recurring situation. A law that cannot be traced back to one of them does not belong here.

---

## 2. Laws

Each law applies the trace test (T), the reality test (R), or both. The laws do not change with a project's stage. Stage only changes what the problem supplies as evidence: stakes, consumers and real inputs.

**L1. Fit the real problem. (T)**
Before building, establish the objective, the real inputs, the stakes and what counts as done. Requirements also have to pass the trace test. If a requirement contradicts the nature of the domain, challenge it before building around it. Scale safeguards to the real stakes, not to the author's anxiety. Define done in terms of the problem's outcomes, not the system's internal signals.

**L2. Give each responsibility to whatever does it reliably and most cheaply. (T)**
Work with one correct answer belongs in deterministic code. Work that needs judgment belongs to a model or a person. Never make a component do work that another component already does reliably, and never add a mechanism whose only job is to catch the mistakes of a misplaced responsibility. Move the responsibility instead.

**L3. Mirror the domain. (T)**
The system's states should match the outcomes the domain actually has, with none missing and none invented. Normal conditions of the world, including absence, unavailability and uncertainty, are represented as values, not treated as errors. Dependencies between parts of the system should match real dependencies in the domain, so a failure reaches only what genuinely depends on it.

**L4. Prefer subtraction. (T)**
For every change, consider removal first. Change things in place. Delete whatever a change makes obsolete within that same change. Keep old forms, versions or compatibility paths only for consumers outside the system that really depend on them.

**L5. Fix causes, not symptoms. (T)**
A fix must name the cause and the class of failure, and must fix the class at the point where it arises. If a fix's justification cites an earlier fix, stop: the chain has stopped tracing to the problem (see §4).

**L6. Let reality judge. (R)**
Get a thin end-to-end path running on real input early, and grow it in response to what real runs reveal. Work is done only when real input has shown that it works. Tests protect contracts and failures that have actually been observed. A measure is evidence, never a target.

---

## 3. NOISE_VETO

These are always vetoed. Each line names the pattern and what to do instead.

- **Test inflation:** tests whose expected values come from the implementation, tests that pin internal details rather than contracts, tests against threats with no evidence behind them, or test count treated as progress. **Instead:** test contracts and observed failures, using real inputs as fixtures.
- **Instruction inflation:** responding to a model's failure by adding instructions, rules or schema to its prompt, or letting a prompt or schema grow with the size of the input. **Instead:** fix the input, split the task, or move the deterministic part into code (L2).
- **False victory:** declaring a fix done without a run on real input, or with the cause still unnamed. **Instead:** apply L5, then L6.
- **Version accumulation:** parallel versions, branches or compatibility layers for internal forms that no outside consumer uses. **Instead:** change in place (L4).
- **Recovery towers:** layered retries, fallbacks or repair passes for conditions that are normal domain outcomes. **Instead:** represent the condition as a value (L3), and use at most one bounded retry for transient faults.
- **Coupling gates:** independent results that wait on each other or fail together. **Instead:** let dependencies follow the domain (L3).

---

## 4. Spiral detection and review

### 4.1 Signals

Any one of these signals means a spiral may be forming:

1. A change is justified by an earlier fix or by another mechanism rather than by the problem.
2. A class of failure comes back after being declared fixed.
3. Something grows (code, states, branches, prompts, schemas, tests) in response to a failure whose cause has not been named.
4. Internal signals pass while real runs fail.
5. Effort goes mainly into the system's own machinery rather than into the problem's outcomes.

### 4.2 Stop protocol

When a signal appears:

1. Stop adding.
2. Name the failure class and its cause.
3. Trace every mechanism involved back to the problem.
4. Remove what does not trace, and fix the class at its origin.
5. Verify on real input.

### 4.3 Review procedure

The subject of a review is a diff, a plan or the current state of the system.

1. **Establish the problem.** Identify the objective, real inputs, stakes and done criterion (L1). If these cannot be established, report that first.
2. **Trace.** Apply the trace test to every mechanism the subject adds or changes, and to the existing mechanisms it relies on.
3. **Check for missing variety.** Look for things the domain actually varies on that have no handling.
4. **Check reality.** Determine what real input showed that this works.
5. **Scan.** Check the subject against §3 and §4.1.

The reviewer must not demand anything that does not trace to the problem, and must not demand removal of anything that does.

### 4.4 Report format

```
VERDICT: FIT | REVISE | STOP (spiral signal present)
PROBLEM: one sentence each: objective, real inputs, stakes, done criterion
FINDINGS (most impactful first):
  - where: <location of the mechanism>
    test: TRACE-INWARD | MISSING-VARIETY | NO-REAL-EVIDENCE | VETO:<name> | SIGNAL:<n>
    why: <what it traces to, or what is missing>
    action: REMOVE | ADD | MOVE | MERGE | VERIFY, plus the concrete step
```
