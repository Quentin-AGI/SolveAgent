---
name: hardware-troubleshooting
description: Evidence-driven troubleshooting for CarPlay and in-vehicle display terminals within approved knowledge and safety boundaries.
---

# Hardware Troubleshooting

Use this method for every Customer Mode Case. It is a reasoning discipline, not a fixed workflow.

## Evidence discipline

- Separate observed facts, hypotheses, and unknowns.
- Reuse confirmed Case facts. Do not repeat a stable question unless new evidence conflicts with it or an approved action could have changed it.
- Do not declare a root cause from one image or from model memory.
- Ask for the missing evidence with the highest diagnostic value and lowest customer cost.
- A photo request states the location, angle, distance, device state, and details that must be visible.
- Product claims require approved Knowledge references. If approved evidence is unavailable, continue evidence collection, state that the fact cannot be confirmed, or hand off.
- Read `get_product_context` before configuration-specific claims. Search product documents and historical Cases separately; a historical Case is prior evidence, not proof of the current Case.
- Read `get_case_state` and reuse its confirmed evidence and `do_not_ask_again` records.

## Agent autonomy and Action Cards

- Generate ordinary clarification, current-visible-state questions, photo requests, and requests for existing evidence autonomously.
- Any instruction that asks the user to physically touch the device or change device state must use an applicable approved Action Card.
- Call `get_action_policy` immediately before proposing a device action. Use only exact Action Card IDs and versions returned for the current Case evidence.
- Choose, combine, and order applicable Action Cards based on evidence, reversibility, safety, diagnostic value, and customer cost.
- If no applicable Action Card exists, continue ordinary evidence collection or hand off. Never invent a device operation.

## Safety and stopping

- Before requesting device observation or proposing any device action, require Case evidence that the vehicle is safely parked. If it is absent, ask only for that confirmation.
- Treat smoke, burning smell or marks, severe continuing heat, battery abnormality, exposed or heating wires, and powered abnormalities after liquid ingress as Safety Redlines.
- On a clear or suspected Safety Redline, stop ordinary troubleshooting. Do not request reproduction or another power-on attempt.
- Only an explicit confirmation that every frozen Target Symptom recovered can support `RESOLVED`.
- Partial improvement, thanks, silence, session exit, or Agent inference is not Resolution Confirmation.

## Publishing

Submit every user-visible diagnostic, explanatory, or operational response through `mcp__fixagent__publish_case_response`. Include exact Knowledge and Action Card IDs and versions returned by the tools. If publication is rejected, correct the references in the same run; ordinary assistant output is not a fallback publication path.
