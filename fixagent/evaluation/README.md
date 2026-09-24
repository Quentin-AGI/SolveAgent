# FixAgent Evaluation Data

Evaluation data is deliberately split into two files:

- `knowledge-snapshot.json` is the only file supplied to the Agent runtime. It
  contains the Case catalog but never prompts or expected answers.
- `evaluation-manifest.private.json` contains prompts, allowed steps, and the
  scoring rubric. Keep it outside every Case workspace and Agent-readable path.

## CAMB fault-tree baseline

The baseline is generated from CAMB's CC0-1.0 `faultTree/trouble_tree.jsonl`:

```sh
FIXAGENT_EVAL_IMPORTED_AT=2026-09-24T00:00:00.000Z \
  pnpm eval:convert:camb \
  evaluation/sources/camb-trouble-tree.jsonl \
  evaluation/camb-fault-tree
```

Score one captured response with:

```sh
pnpm eval:score \
  evaluation/camb-fault-tree/evaluation-manifest.private.json \
  CAMB-FAULT-TREE-0001 \
  response.txt
```

The deterministic scorer measures literal normalized allowed-step coverage. It
is a reproducible baseline, not a semantic judge for paraphrased answers.
CAMB faultTree does not include fault-classification labels, so those arrays are
intentionally empty; no classifications are inferred or fabricated.

This imported suite is a cross-domain transfer and safety probe. It is not a
CAMB-comparable score or a measure of FixAgent product-diagnosis accuracy. The
runtime snapshot intentionally contains no gold-derived documents or Action
Cards, so a policy-compliant Agent may decline aviation maintenance operations;
that outcome must be reported separately from reasoning quality. CAMB's
published evaluation uses semantic judging, while this first local scorer is a
strict, deterministic smoke-test metric.

The manifest records a SHA-256 hash of the vendored source JSONL so regenerated
artifacts cannot silently move with the upstream `main` branch.

With FixAgent running against the generated Knowledge Snapshot, execute the
whole baseline and write a report with:

```sh
FIXAGENT_KNOWLEDGE_SNAPSHOT_FILE=evaluation/camb-fault-tree/knowledge-snapshot.json \
  pnpm dev

pnpm eval:run \
  http://127.0.0.1:4174 \
  evaluation/camb-fault-tree/evaluation-manifest.private.json \
  evaluation/camb-fault-tree/report.json \
  qwen
```

The runner sends only each prompt and public evaluation Case ID to the server.
Expected answers remain in the runner process and are never copied into a Case.

## RAFT historical Case import

Export RAFT trajectories as JSONL using the normalized contract in
`src/historical-case-import.ts`, then run:

```sh
pnpm knowledge:import:raft trajectories.jsonl import-options.json documents.json
```

The command creates reviewed `HISTORICAL_CASE` document inputs. They still need
to be included in a new hash-locked Knowledge Snapshot before the runtime can
retrieve them.
