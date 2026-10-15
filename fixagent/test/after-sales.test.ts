import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  createAfterSalesDataset,
  createAfterSalesService,
  issueAfterSalesEvidenceRef,
  loadIssuedAfterSalesEvidenceRefs,
} from "../src/after-sales.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const dataset = createAfterSalesDataset({
  schema_version: "fixagent.after-sales-data.v0",
  data_status: "SIMULATED",
  products: [
    {
      entity_id: "EUFY-ROBOT-VACUUM-S1-PRO",
      manufacturer: "Anker Innovations",
      brand: "eufy",
      category: "ROBOT_VACUUM",
      model_name: "S1 Pro",
      sku: "DEMO-T2080",
      aliases: ["eufy S1 Pro", "S1 Pro"],
      disambiguation_terms: ["扫地机器人", "主刷", "边刷", "基站", "拖布"],
    },
    {
      entity_id: "EUFY-BREAST-PUMP-S1-PRO",
      manufacturer: "Anker Innovations",
      brand: "eufy",
      category: "BREAST_PUMP",
      model_name: "S1 Pro",
      sku: null,
      aliases: ["eufy S1 Pro", "S1 Pro"],
      disambiguation_terms: ["吸奶器", "泵奶", "奶瓶"],
    },
  ],
  orders: [
    {
      order_number: "DEMO-ORDER-0001",
      product_sku: "DEMO-T2080",
      quantity: 1,
      amount: 999.99,
      currency: "USD",
      purchase_date: "2026-01-10",
      warranty_expiry_date: "2027-01-09",
      shipping_address: "123 Example Street, Seattle, WA",
      order_status: "DELIVERED",
      carrier: "Demo Carrier",
      tracking_number: "DEMO-TRACK-9876",
      ship_date: "2026-01-11",
      country: "US",
      seller: "eufy Direct",
    },
  ],
  authorized_dealers: [
    {
      country: "US",
      seller_name: "Example Authorized Retailer",
      aliases: ["Example Authorised Retailer LLC"],
    },
  ],
});

test("S1 Pro is resolved only when category evidence disambiguates the product", () => {
  const service = createAfterSalesService(dataset, {
    now: () => new Date("2026-09-24T00:00:00.000Z"),
  });

  assert.equal(
    service.resolveProductIdentity({ text: "我的 eufy S1 Pro 出问题了" })
      .status,
    "AMBIGUOUS",
  );
  const robot = service.resolveProductIdentity({
    text: "eufy S1 Pro 扫地机器人无法回到基站",
  });
  assert.equal(robot.status, "RESOLVED");
  assert.equal(robot.product?.category, "ROBOT_VACUUM");
  assert.equal(robot.product?.manufacturer, "Anker Innovations");
  assert.match(robot.evidence_ref ?? "", /^product-identity:[a-f0-9]{16}$/);
});

test("order lookup is masked and warranty status is deterministic", () => {
  const service = createAfterSalesService(dataset, {
    now: () => new Date("2026-09-24T00:00:00.000Z"),
  });

  const order = service.getMaskedOrder("DEMO-ORDER-0001");
  assert.equal(order.status, "FOUND");
  assert.equal(order.order?.order_number, "***************0001");
  assert.equal(order.order?.shipping_address, "US · ***");
  assert.equal(order.order?.tracking_number, "***************9876");
  assert.equal(JSON.stringify(order).includes("Example Street"), false);

  const warranty = service.determineWarrantyStatus("DEMO-ORDER-0001");
  assert.equal(warranty.status, "IN_WARRANTY");
  assert.equal(warranty.evidence.purchase_date, "2026-01-10");
  assert.equal(warranty.evidence.warranty_expiry_date, "2027-01-09");
  assert.match(warranty.evidence_ref ?? "", /^warranty:[a-f0-9]{16}$/);
});

test("authorized dealer requires exact country and deterministic fuzzy seller match", () => {
  const service = createAfterSalesService(dataset);

  assert.equal(
    service.verifyAuthorizedDealer({
      country: "US",
      seller: "Example Authorised Retailer",
    }).status,
    "AUTHORIZED",
  );
  assert.equal(
    service.verifyAuthorizedDealer({
      country: "CA",
      seller: "Example Authorized Retailer",
    }).status,
    "NOT_AUTHORIZED",
  );
});

test("after-sales tools create only a draft and a pending human confirmation", async () => {
  const caseWorkspaceRoot = await mkdtemp(
    join(tmpdir(), "fixagent-after-sales-test-"),
  );
  temporaryDirectories.push(caseWorkspaceRoot);
  const service = createAfterSalesService(dataset, {
    now: () => new Date("2026-09-24T00:00:00.000Z"),
  });

  const draft = await service.createAfterSalesDraft({
    caseId: "case-123",
    caseWorkspaceRoot,
    actionType: "REPLACEMENT",
    reason: "Approved test-only replacement request.",
    orderNumber: "DEMO-ORDER-0001",
  });
  assert.equal(draft.status, "DRAFT_REQUIRES_HUMAN_CONFIRMATION");
  assert.equal(draft.executed, false);

  const confirmation = await service.requestHumanConfirmation({
    caseId: "case-123",
    caseWorkspaceRoot,
    draftId: draft.draft_id,
  });
  assert.equal(confirmation.status, "PENDING_HUMAN_CONFIRMATION");
  assert.equal(confirmation.executed, false);

  const persisted = JSON.parse(
    await readFile(
      join(caseWorkspaceRoot, "after_sales_outbox", `${draft.draft_id}.json`),
      "utf8",
    ),
  ) as { order_number?: string; status?: string };
  assert.equal(persisted.order_number, undefined);
  assert.equal(persisted.status, "DRAFT_REQUIRES_HUMAN_CONFIRMATION");

  const idempotentDraft = await service.createAfterSalesDraft({
    caseId: "case-123",
    caseWorkspaceRoot,
    actionType: "REPLACEMENT",
    reason: "Approved test-only replacement request.",
    orderNumber: "DEMO-ORDER-0001",
  });
  assert.equal(idempotentDraft.created_at, draft.created_at);
});

test("complaint evidence is structured, immutable, and explicitly unverified", async () => {
  const caseWorkspaceRoot = await mkdtemp(
    join(tmpdir(), "fixagent-complaint-evidence-test-"),
  );
  temporaryDirectories.push(caseWorkspaceRoot);
  const service = createAfterSalesService(dataset, {
    now: () => new Date("2026-09-24T00:00:00.000Z"),
  });

  const record = await service.recordComplaintEvidence({
    caseId: "case-complaint-1",
    caseWorkspaceRoot,
    sourceTypes: ["EMAIL", "ORDER_SCREENSHOT", "VIDEO_KEYFRAME"],
    productMentions: ["eufy S1 Pro"],
    observedIssueLabels: ["无法回到基站"],
    orderEvidenceStatus: "SCREENSHOT_UNVERIFIED",
    emotion: "FRUSTRATED",
    evidenceRefs: ["attachment:email-1", "attachment:keyframe-2"],
  });

  assert.equal(record.status, "AGENT_EXTRACTED_UNVERIFIED");
  assert.equal(record.order_evidence_status, "SCREENSHOT_UNVERIFIED");
  const persisted = JSON.parse(
    await readFile(
      join(caseWorkspaceRoot, "complaint_evidence", `${record.record_id}.json`),
      "utf8",
    ),
  ) as { content_hash?: string; status?: string };
  assert.match(persisted.content_hash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(persisted.status, "AGENT_EXTRACTED_UNVERIFIED");
});

test("issued after-sales evidence is hash-verified and scoped to one Case", async () => {
  const caseWorkspaceRoot = await mkdtemp(
    join(tmpdir(), "fixagent-issued-evidence-test-"),
  );
  temporaryDirectories.push(caseWorkspaceRoot);

  await issueAfterSalesEvidenceRef({
    caseId: "case-evidence-1",
    caseWorkspaceRoot,
    evidenceRef: "order:0123456789abcdef",
    evidenceType: "ORDER",
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  await issueAfterSalesEvidenceRef({
    caseId: "case-evidence-1",
    caseWorkspaceRoot,
    evidenceRef: "order:0123456789abcdef",
    evidenceType: "ORDER",
    createdAt: "2026-09-24T00:00:01.000Z",
  });

  assert.deepEqual(
    await loadIssuedAfterSalesEvidenceRefs({
      caseId: "case-evidence-1",
      caseWorkspaceRoot,
    }),
    ["order:0123456789abcdef"],
  );
  await assert.rejects(
    loadIssuedAfterSalesEvidenceRefs({
      caseId: "different-case",
      caseWorkspaceRoot,
    }),
    /AFTER_SALES_EVIDENCE_LEDGER_MISMATCH/,
  );
});
