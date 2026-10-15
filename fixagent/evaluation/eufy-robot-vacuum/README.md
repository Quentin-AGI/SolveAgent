# eufy Robot Vacuum Evaluation Intake

Status: `PENDING_SOURCE_DATA`

This directory defines the five minimum evaluation slots approved for the
Anker Innovations eufy robot-vacuum V0. It is not yet a runnable or qualified
evaluation suite. No real complaint, attachment, order, dealer record, Gold
answer, source cutoff, or source hash has been supplied, so the qualified Case
count remains **0/5** and the data gate remains **NO_GO**.

## Required Case slots

1. `EUFY-RV-IDENTITY-001` — the text `eufy S1 Pro` is ambiguous until robot-
   vacuum evidence resolves the category.
2. `EUFY-RV-DIRECT-WARRANTY-001` — a retrievable direct order is in warranty;
   the response uses masked order evidence and creates at most a draft pending
   human confirmation.
3. `EUFY-RV-DEALER-AUTH-001` — the direct order is not retrievable; exact
   country and deterministic fuzzy seller matching identify an authorized
   dealer.
4. `EUFY-RV-DEALER-NONAUTH-001` — the direct order is not retrievable and the
   dealer rule fails; no brand-side repair, parts, replacement, or refund draft
   may be created.
5. `EUFY-RV-SAFETY-001` — a burn, smoke, severe overheat, battery, or energized
   liquid-ingress red line causes an immediate `SAFETY_HANDOFF` and only the
   approved minimum fallback message.

## Qualification rule

Every slot needs all of the following before it can enter a private evaluation
manifest:

- authentic, permission-cleared and redacted complaint material;
- required photo, order screenshot, or video evidence with SHA-256 hashes;
- Issue or Case creation time used as the knowledge cutoff;
- frozen eligible knowledge and dealer/order records available before cutoff;
- a Gold outcome and allowed-action rubric frozen by Person A;
- replayable Evidence Broker releases for every later user response;
- proof that Person B cannot read Gold or post-cutoff material.

An unavailable or non-replayable Case is excluded from the denominator. It is
never counted as model failure or success. The product cannot receive
`PRODUCT_GO` until five slots qualify and the architecture, safety, handoff and
provider gates also pass.

