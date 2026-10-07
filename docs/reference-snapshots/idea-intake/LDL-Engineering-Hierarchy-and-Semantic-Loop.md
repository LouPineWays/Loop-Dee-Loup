# LDL Engineering Hierarchy and Semantic Loop

## Purpose

Record the conceptual hierarchy LDL should use when distinguishing founder intent, semantic judgment, reasoning machinery, and deterministic execution.

This is a north-star reference, not an implementation specification or automatic authorization for new work.

## Hierarchy

```text
Founder
“What do I want?”
        ↓
Semantic Engineering
“Given what the Founder wants, is this the right thing to do?”
        ↓
Graph Engineering
        ↓
Loop Engineering
        ↓
Harness Engineering
        ↓
Context Engineering
        ↓
Prompt Engineering
        ↓
Deterministic Engineering
```

The Founder is not an engineering layer. The Founder supplies the desired outcomes, values, priorities, and consequential choices the system exists to serve.

Semantic Engineering reasons toward founder intent. It asks whether the objective, interpretation, decomposition, correction, or observed result is actually consistent with what the Founder wants. It may expose ambiguity, contradictions, tradeoffs, or mistaken intermediate objectives, but it must not redefine founder preferences merely because another objective would be easier, cheaper, more measurable, or more internally convenient.

Its governing responsibility is to **preserve the Founder/user's values and intended outcomes across every lower engineering layer**. Technical correctness is necessary but not sufficient. A worker may faithfully satisfy its bounded instructions, a deterministic verifier may prove every stated check, and each local output may be correct while the combined result is still wrong because an intermediate objective, decomposition, acceptance condition, or specification failed to preserve the intended outcome.

Conceptually:

```text
Founder/user values + intended outcome
        ↓
Semantic Engineering
“Is this still the right thing, given what the Founder wants?”
        ↓
lower engineering layers
“Did we correctly produce what we were instructed to produce?”
```

Therefore:

```text
mechanically correct
+ specification-compliant
+ tests passing
≠
necessarily semantically correct
```

Semantic Engineering must be able to detect when individually correct sub-results compose into the wrong whole, when literal compliance violates the underlying purpose, or when the available proof establishes the stated mechanism but not the Founder-valued result. In those cases it should identify the missing or incorrect higher-level invariant and route the correction downward through the normal bounded execution machinery.

From Graph Engineering downward, the primary question is **how to accomplish an accepted objective**.

## Deterministic Engineering as the lower target

Deterministic Engineering is the preferred destination for work that no longer requires judgment.

A common maturation path is:

```text
novel semantic judgment
→ recurring reasoning problem
→ structured reasoning / prompt
→ stable procedure
→ deterministic implementation
```

The ideal result of successful Prompt Engineering is therefore not always a better prompt. When the relevant choice has become sufficiently closed, stable, and mechanically decidable, the stronger outcome is to remove model judgment from that path and execute it deterministically.

Do not force work downward merely because reasoning is expensive. Determinization is appropriate only when the closed procedure preserves correctness and required authority.

## Semantic Engineering loops back into the execution stack

Semantic Engineering is conceptually above Graph Engineering because it evaluates whether the system is pursuing the right thing. But when Semantic Engineering is performed by an LLM, the semantic reasoning itself must be instantiated through the lower stack: prompts, context, harnesses, loops, and graphs.

Therefore Semantic Engineering loops back into Prompt Engineering and the rest of the execution stack as its implementation mechanism.

This does **not** create an infinite sequence of Meta-Semantic Engineering layers. The semantic question remains grounded in the Founder-supplied criterion:

> Given what the Founder wants, is this the right thing to do?

When the remaining uncertainty is a genuine value or intent question that cannot be derived from existing founder authority, reasoning terminates and returns to the Founder.

## Two stopping conditions for reasoning

The hierarchy is bounded in both directions:

- **Upward:** when uncertainty becomes a genuine founder-owned value, priority, or intent decision, return it to the Founder.
- **Downward:** when judgment is no longer necessary, compile the operation into deterministic execution.

The purpose of the stack is not to maximize increasingly elaborate reasoning. It is to preserve semantic judgment where intent or meaning remains open while continuously moving closed, repeatable work toward the cheapest reliable deterministic mechanism.

## Relationship to LDL

This model is consistent with LDL's existing principles that:

- the Founder owns objectives and consequential choices;
- semantic reasoning is reserved for genuine uncertainty;
- mechanically decidable operations should move below model reasoning;
- repeated reasoning should be promoted into procedures or deterministic tooling when recurrence and stability justify the persistent complexity; and
- the system optimizes validated useful progress per scarce resource rather than model usage or automation for its own sake.

Use this note as a conceptual lens when deciding which layer should own a problem. Do not treat a mismatch with the hierarchy as automatic authorization for implementation work.