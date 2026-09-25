import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const hashPattern = /^[a-f0-9]{64}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const sha256 = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

const productSchema = z
  .object({
    entity_id: z.string().trim().min(1),
    manufacturer: z.string().trim().min(1),
    brand: z.string().trim().min(1),
    category: z.enum(["ROBOT_VACUUM", "BREAST_PUMP"]),
    model_name: z.string().trim().min(1),
    sku: z.string().trim().min(1).nullable(),
    aliases: z.array(z.string().trim().min(1)).min(1),
    disambiguation_terms: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const orderSchema = z
  .object({
    order_number: z.string().trim().min(1),
    product_sku: z.string().trim().min(1),
    quantity: z.number().int().positive(),
    amount: z.number().nonnegative(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    purchase_date: z.string().regex(datePattern),
    warranty_expiry_date: z.string().regex(datePattern),
    shipping_address: z.string().trim().min(1),
    order_status: z.string().trim().min(1),
    carrier: z.string().trim().min(1).nullable(),
    tracking_number: z.string().trim().min(1).nullable(),
    ship_date: z.string().regex(datePattern).nullable(),
    country: z.string().trim().regex(/^[A-Z]{2}$/),
    seller: z.string().trim().min(1),
  })
  .strict();

const authorizedDealerSchema = z
  .object({
    country: z.string().trim().regex(/^[A-Z]{2}$/),
    seller_name: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)),
  })
  .strict();

const datasetInputSchema = z
  .object({
    schema_version: z.literal("fixagent.after-sales-data.v0"),
    data_status: z.enum(["NOT_CONFIGURED", "SIMULATED", "PROVIDED_REDACTED"]),
    products: z.array(productSchema),
    orders: z.array(orderSchema),
    authorized_dealers: z.array(authorizedDealerSchema),
  })
  .strict();

const datasetSchema = datasetInputSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const afterSalesDraftBodySchema = z
  .object({
    schema_version: z.literal("fixagent.after-sales-draft.v0"),
    case_id: z.string().min(1),
    draft_id: z.string().regex(/^[a-f0-9]{32}$/),
    action_type: z.enum(["REPAIR", "REPLACEMENT", "PARTS", "REFUND"]),
    reason: z.string().trim().min(1).max(1_000),
    eligibility_evidence_ref: z.string().min(1),
    status: z.literal("DRAFT_REQUIRES_HUMAN_CONFIRMATION"),
    executed: z.literal(false),
    created_at: z.string().datetime(),
  })
  .strict();

const afterSalesDraftSchema = afterSalesDraftBodySchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const humanConfirmationBodySchema = z
  .object({
    schema_version: z.literal("fixagent.human-confirmation.v0"),
    case_id: z.string().min(1),
    draft_id: z.string().regex(/^[a-f0-9]{32}$/),
    status: z.literal("PENDING_HUMAN_CONFIRMATION"),
    executed: z.literal(false),
    requested_at: z.string().datetime(),
  })
  .strict();

const humanConfirmationSchema = humanConfirmationBodySchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const complaintEvidenceBodySchema = z
  .object({
    schema_version: z.literal("fixagent.complaint-evidence.v0"),
    case_id: z.string().min(1),
    record_id: z.string().regex(/^[a-f0-9]{32}$/),
    source_types: z
      .array(z.enum(["EMAIL", "PHOTO", "ORDER_SCREENSHOT", "VIDEO_KEYFRAME", "TEXT"]))
      .min(1)
      .max(5),
    product_mentions: z.array(z.string().trim().min(1).max(120)).max(10),
    observed_issue_labels: z.array(z.string().trim().min(1).max(120)).max(20),
    order_evidence_status: z.enum([
      "NOT_PRESENT",
      "SCREENSHOT_UNVERIFIED",
      "LOOKUP_PENDING",
      "VERIFIED_VIA_TOOL",
    ]),
    emotion: z.enum([
      "CALM",
      "CONFUSED",
      "FRUSTRATED",
      "ANGRY",
      "DISTRESSED",
      "UNKNOWN",
    ]),
    evidence_refs: z.array(z.string().trim().min(1).max(240)).max(40),
    status: z.literal("AGENT_EXTRACTED_UNVERIFIED"),
    created_at: z.string().datetime(),
  })
  .strict();

const complaintEvidenceSchema = complaintEvidenceBodySchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const issuedEvidenceBodySchema = z
  .object({
    schema_version: z.literal("fixagent.issued-case-evidence.v0"),
    case_id: z.string().min(1),
    evidence_ref: z.string().trim().min(1).max(240),
    evidence_type: z.enum([
      "PRODUCT_IDENTITY",
      "ORDER",
      "WARRANTY",
      "DEALER",
      "COMPLAINT_SUMMARY",
      "AFTER_SALES_DRAFT",
      "HUMAN_CONFIRMATION",
    ]),
    created_at: z.string().datetime(),
  })
  .strict();

const issuedEvidenceSchema = issuedEvidenceBodySchema.extend({
  content_hash: z.string().regex(hashPattern),
});

export type AfterSalesDatasetInput = z.infer<typeof datasetInputSchema>;
export type AfterSalesDataset = z.infer<typeof datasetSchema>;

export const createAfterSalesDataset = (
  input: AfterSalesDatasetInput,
): AfterSalesDataset => {
  const parsed = datasetInputSchema.parse(input);
  const orderNumbers = parsed.orders.map((order) => order.order_number);
  if (new Set(orderNumbers).size !== orderNumbers.length) {
    throw new Error("AFTER_SALES_DUPLICATE_ORDER_NUMBER");
  }
  const entityIds = parsed.products.map((product) => product.entity_id);
  if (new Set(entityIds).size !== entityIds.length) {
    throw new Error("AFTER_SALES_DUPLICATE_PRODUCT_ENTITY");
  }
  return datasetSchema.parse({ ...parsed, content_hash: sha256(parsed) });
};

export const parseAfterSalesDataset = (candidate: unknown): AfterSalesDataset => {
  const parsed = datasetSchema.parse(candidate);
  const { content_hash: contentHash, ...withoutHash } = parsed;
  if (sha256(withoutHash) !== contentHash) {
    throw new Error("AFTER_SALES_DATA_HASH_MISMATCH");
  }
  return createAfterSalesDataset(withoutHash);
};

export const loadAfterSalesDatasetFile = async (
  path: string,
): Promise<AfterSalesDataset> =>
  parseAfterSalesDataset(JSON.parse(await readFile(path, "utf8")));

export const DEFAULT_EUFY_AFTER_SALES_DATASET = createAfterSalesDataset({
  schema_version: "fixagent.after-sales-data.v0",
  data_status: "NOT_CONFIGURED",
  products: [
    {
      entity_id: "EUFY-ROBOT-VACUUM-S1-PRO",
      manufacturer: "Anker Innovations",
      brand: "eufy",
      category: "ROBOT_VACUUM",
      model_name: "S1 Pro",
      sku: null,
      aliases: ["eufy S1 Pro", "S1 Pro"],
      disambiguation_terms: [
        "扫地机器人",
        "扫地机",
        "robot vacuum",
        "主刷",
        "边刷",
        "基站",
        "尘盒",
        "拖布",
        "回充",
      ],
    },
    {
      entity_id: "EUFY-BREAST-PUMP-S1-PRO",
      manufacturer: "Anker Innovations",
      brand: "eufy",
      category: "BREAST_PUMP",
      model_name: "S1 Pro",
      sku: null,
      aliases: ["eufy S1 Pro", "S1 Pro"],
      disambiguation_terms: ["吸奶器", "breast pump", "泵奶", "奶瓶"],
    },
  ],
  orders: [],
  authorized_dealers: [],
});

const normalizeText = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

const maskIdentifier = (value: string | null): string | null =>
  value ? `${"*".repeat(15)}${value.slice(-4)}` : null;

const productView = (product: AfterSalesDataset["products"][number]) => ({
  entity_id: product.entity_id,
  manufacturer: product.manufacturer,
  brand: product.brand,
  category: product.category,
  model_name: product.model_name,
  sku: product.sku,
});

const levenshteinDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
};

const sellerSimilarity = (left: string, right: string): number => {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return (
      Math.min(normalizedLeft.length, normalizedRight.length) /
      Math.max(normalizedLeft.length, normalizedRight.length)
    );
  }
  return (
    1 -
    levenshteinDistance(normalizedLeft, normalizedRight) /
      Math.max(normalizedLeft.length, normalizedRight.length)
  );
};

const parseHashedArtifact = <T extends { content_hash: string }>(
  schema: z.ZodType<T>,
  candidate: unknown,
): T => {
  const parsed = schema.parse(candidate);
  const { content_hash: contentHash, ...withoutHash } = parsed;
  if (sha256(withoutHash) !== contentHash) {
    throw new Error("AFTER_SALES_ARTIFACT_HASH_MISMATCH");
  }
  return parsed;
};

const writeOnce = async <T>(
  path: string,
  value: T,
  isEquivalent: (existing: unknown, proposed: T) => boolean,
): Promise<T | unknown> => {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return value;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isEquivalent(existing, value)) {
      throw new Error("AFTER_SALES_IDEMPOTENCY_CONFLICT");
    }
    return existing;
  }
};

export type IssuedCaseEvidenceType = z.infer<
  typeof issuedEvidenceBodySchema
>["evidence_type"];

export const issueAfterSalesEvidenceRef = async ({
  caseId,
  caseWorkspaceRoot,
  evidenceRef,
  evidenceType,
  createdAt = new Date().toISOString(),
}: {
  caseId: string;
  caseWorkspaceRoot: string;
  evidenceRef: string;
  evidenceType: IssuedCaseEvidenceType;
  createdAt?: string;
}): Promise<void> => {
  const body = issuedEvidenceBodySchema.parse({
    schema_version: "fixagent.issued-case-evidence.v0",
    case_id: caseId,
    evidence_ref: evidenceRef,
    evidence_type: evidenceType,
    created_at: createdAt,
  });
  const directory = join(caseWorkspaceRoot, "issued_evidence");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${sha256(evidenceRef)}.json`);
  await writeOnce(path, { ...body, content_hash: sha256(body) }, (existing) => {
    const parsed = parseHashedArtifact(issuedEvidenceSchema, existing);
    return (
      parsed.case_id === caseId &&
      parsed.evidence_ref === evidenceRef &&
      parsed.evidence_type === evidenceType
    );
  });
};

export const loadIssuedAfterSalesEvidenceRefs = async ({
  caseId,
  caseWorkspaceRoot,
}: {
  caseId: string;
  caseWorkspaceRoot: string;
}): Promise<string[]> => {
  const directory = join(caseWorkspaceRoot, "issued_evidence");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  if (names.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) {
    throw new Error("AFTER_SALES_EVIDENCE_LEDGER_ENTRY_INVALID");
  }
  const references = await Promise.all(
    names.map(async (name) => {
        const parsed = parseHashedArtifact(
          issuedEvidenceSchema,
          JSON.parse(await readFile(join(directory, name), "utf8")),
        );
        if (
          parsed.case_id !== caseId ||
          `${sha256(parsed.evidence_ref)}.json` !== name
        ) {
          throw new Error("AFTER_SALES_EVIDENCE_LEDGER_MISMATCH");
        }
        return parsed.evidence_ref;
      }),
  );
  return [...new Set(references)].sort();
};

export interface AfterSalesServiceOptions {
  now?: () => Date;
  dealerSimilarityThreshold?: number;
}

export const createAfterSalesService = (
  dataset: AfterSalesDataset,
  {
    now = () => new Date(),
    dealerSimilarityThreshold = 0.82,
  }: AfterSalesServiceOptions = {},
) => {
  const resolveProductIdentity = ({
    text,
    categoryHint,
    imageLabels = [],
    sku,
  }: {
    text: string;
    categoryHint?: "ROBOT_VACUUM" | "BREAST_PUMP";
    imageLabels?: string[];
    sku?: string;
  }) => {
    const evidence = normalizeText([text, ...imageLabels].join(" "));
    const skuCandidates = sku
      ? dataset.products.filter((product) => product.sku === sku)
      : [];
    const aliasCandidates = dataset.products.filter((product) =>
      product.aliases.some((alias) => evidence.includes(normalizeText(alias))),
    );
    let candidates = skuCandidates.length > 0 ? skuCandidates : aliasCandidates;
    if (categoryHint) {
      candidates = candidates.filter((product) => product.category === categoryHint);
    }
    const scored = candidates.map((product) => ({
      product,
      score: product.disambiguation_terms.filter((term) =>
        evidence.includes(normalizeText(term)),
      ).length,
    }));
    const highestScore = Math.max(0, ...scored.map((candidate) => candidate.score));
    const winners = scored.filter((candidate) => candidate.score === highestScore);
    if (
      skuCandidates.length === 1 ||
      (categoryHint && candidates.length === 1) ||
      (highestScore > 0 && winners.length === 1)
    ) {
      const product = (skuCandidates.length === 1
        ? skuCandidates[0]
        : winners[0]?.product ?? candidates[0])!;
      return {
        status: "RESOLVED" as const,
        data_status: dataset.data_status,
        product: productView(product),
        evidence_ref: `product-identity:${sha256([
          product.entity_id,
          evidence,
          sku ?? null,
          categoryHint ?? null,
        ]).slice(0, 16)}`,
        candidate_entity_ids: [product.entity_id],
        required_evidence: [] as string[],
      };
    }
    if (candidates.length > 0) {
      return {
        status: "AMBIGUOUS" as const,
        data_status: dataset.data_status,
        product: null,
        candidate_entity_ids: candidates.map((product) => product.entity_id),
        required_evidence: ["产品品类", "产品外观或包装标签", "订单 SKU"],
      };
    }
    return {
      status: "NOT_FOUND" as const,
      data_status: dataset.data_status,
      product: null,
      candidate_entity_ids: [] as string[],
      required_evidence: ["品牌", "完整型号", "产品品类", "订单 SKU"],
    };
  };

  const findOrder = (orderNumber: string) =>
    dataset.orders.find((order) => order.order_number === orderNumber.trim());

  const getMaskedOrder = (orderNumber: string) => {
    const order = findOrder(orderNumber);
    if (!order) {
      return { status: "NOT_FOUND" as const, data_status: dataset.data_status };
    }
    return {
      status: "FOUND" as const,
      data_status: dataset.data_status,
      evidence_ref: `order:${sha256(order.order_number).slice(0, 16)}`,
      order: {
        order_number: maskIdentifier(order.order_number),
        product_sku: order.product_sku,
        quantity: order.quantity,
        amount: order.amount,
        currency: order.currency,
        purchase_date: order.purchase_date,
        warranty_expiry_date: order.warranty_expiry_date,
        shipping_address: `${order.country} · ***`,
        order_status: order.order_status,
        carrier: order.carrier,
        tracking_number: maskIdentifier(order.tracking_number),
        ship_date: order.ship_date,
      },
    };
  };

  const determineWarrantyStatus = (orderNumber: string) => {
    const order = findOrder(orderNumber);
    if (!order) {
      return {
        status: "ORDER_NOT_FOUND" as const,
        data_status: dataset.data_status,
        evidence: {},
      };
    }
    const invalidOrder = /cancel|refund|closed|取消|退款|关闭/iu.test(
      order.order_status,
    );
    const asOfDate = now().toISOString().slice(0, 10);
    const status = invalidOrder
      ? ("ORDER_INELIGIBLE" as const)
      : asOfDate <= order.warranty_expiry_date
        ? ("IN_WARRANTY" as const)
        : ("OUT_OF_WARRANTY" as const);
    return {
      status,
      data_status: dataset.data_status,
      evidence_ref: `warranty:${sha256([
        order.order_number,
        asOfDate,
        status,
      ]).slice(0, 16)}`,
      evidence: {
        product_sku: order.product_sku,
        purchase_date: order.purchase_date,
        warranty_expiry_date: order.warranty_expiry_date,
        order_status: order.order_status,
        as_of_date: asOfDate,
      },
    };
  };

  const verifyAuthorizedDealer = ({
    country,
    seller,
  }: {
    country: string;
    seller: string;
  }) => {
    const normalizedCountry = country.trim().toLocaleUpperCase();
    const matches = dataset.authorized_dealers
      .filter((dealer) => dealer.country === normalizedCountry)
      .flatMap((dealer) =>
        [dealer.seller_name, ...dealer.aliases].map((candidate) => ({
          dealer,
          score: sellerSimilarity(seller, candidate),
        })),
      )
      .sort((left, right) => right.score - left.score);
    const best = matches[0];
    if (!best || best.score < dealerSimilarityThreshold) {
      return {
        status: "NOT_AUTHORIZED" as const,
        data_status: dataset.data_status,
        country: normalizedCountry,
        match_score: best?.score ?? 0,
      };
    }
    return {
      status: "AUTHORIZED" as const,
      data_status: dataset.data_status,
      country: normalizedCountry,
      matched_dealer_name: best.dealer.seller_name,
      match_score: best.score,
      evidence_ref: `dealer:${sha256([
        normalizedCountry,
        best.dealer.seller_name,
      ]).slice(0, 16)}`,
    };
  };

  const createAfterSalesDraft = async ({
    caseId,
    caseWorkspaceRoot,
    actionType,
    reason,
    orderNumber,
    dealerCountry,
    dealerSeller,
  }: {
    caseId: string;
    caseWorkspaceRoot: string;
    actionType: "REPAIR" | "REPLACEMENT" | "PARTS" | "REFUND";
    reason: string;
    orderNumber?: string;
    dealerCountry?: string;
    dealerSeller?: string;
  }) => {
    let eligibilityEvidence:
      | ReturnType<typeof determineWarrantyStatus>
      | ReturnType<typeof verifyAuthorizedDealer>;
    const hasDealerCountry = Boolean(dealerCountry);
    const hasDealerSeller = Boolean(dealerSeller);
    if (
      (orderNumber && (hasDealerCountry || hasDealerSeller)) ||
      hasDealerCountry !== hasDealerSeller
    ) {
      throw new Error("AFTER_SALES_ELIGIBILITY_EVIDENCE_AMBIGUOUS");
    }
    if (orderNumber) {
      eligibilityEvidence = determineWarrantyStatus(orderNumber);
      if (eligibilityEvidence.status !== "IN_WARRANTY") {
        throw new Error("AFTER_SALES_DRAFT_NOT_ELIGIBLE");
      }
    } else if (dealerCountry && dealerSeller) {
      eligibilityEvidence = verifyAuthorizedDealer({
        country: dealerCountry,
        seller: dealerSeller,
      });
      if (eligibilityEvidence.status !== "AUTHORIZED") {
        throw new Error("AFTER_SALES_DRAFT_NOT_ELIGIBLE");
      }
    } else {
      throw new Error("AFTER_SALES_ELIGIBILITY_EVIDENCE_REQUIRED");
    }
    const eligibilityRef =
      "evidence_ref" in eligibilityEvidence
        ? eligibilityEvidence.evidence_ref
        : undefined;
    const draftId = sha256([
      caseId,
      actionType,
      reason,
      eligibilityRef,
    ]).slice(0, 32);
    const draft = {
      schema_version: "fixagent.after-sales-draft.v0",
      case_id: caseId,
      draft_id: draftId,
      action_type: actionType,
      reason,
      eligibility_evidence_ref: eligibilityRef,
      status: "DRAFT_REQUIRES_HUMAN_CONFIRMATION" as const,
      executed: false as const,
      created_at: now().toISOString(),
    };
    const outbox = join(caseWorkspaceRoot, "after_sales_outbox");
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    const stored = await writeOnce(join(outbox, `${draftId}.json`), {
      ...draft,
      content_hash: sha256(draft),
    }, (existing) => {
      const parsed = parseHashedArtifact(afterSalesDraftSchema, existing);
      return (
        parsed.case_id === draft.case_id &&
        parsed.draft_id === draft.draft_id &&
        parsed.action_type === draft.action_type &&
        parsed.reason === draft.reason &&
        parsed.eligibility_evidence_ref === draft.eligibility_evidence_ref
      );
    });
    const parsedStored = parseHashedArtifact(afterSalesDraftSchema, stored);
    const { content_hash: _contentHash, ...storedDraft } = parsedStored;
    return {
      ...storedDraft,
      evidence_ref: `after-sales-draft:${storedDraft.draft_id}`,
    };
  };

  const requestHumanConfirmation = async ({
    caseId,
    caseWorkspaceRoot,
    draftId,
  }: {
    caseId: string;
    caseWorkspaceRoot: string;
    draftId: string;
  }) => {
    if (!/^[a-f0-9]{32}$/.test(draftId)) {
      throw new Error("AFTER_SALES_DRAFT_ID_INVALID");
    }
    const outbox = join(caseWorkspaceRoot, "after_sales_outbox");
    const draft = parseHashedArtifact(
      afterSalesDraftSchema,
      JSON.parse(await readFile(join(outbox, `${draftId}.json`), "utf8")),
    );
    if (draft.case_id !== caseId || draft.draft_id !== draftId) {
      throw new Error("AFTER_SALES_DRAFT_CASE_MISMATCH");
    }
    const confirmation = {
      schema_version: "fixagent.human-confirmation.v0",
      case_id: caseId,
      draft_id: draftId,
      status: "PENDING_HUMAN_CONFIRMATION" as const,
      executed: false as const,
      requested_at: now().toISOString(),
    };
    const stored = await writeOnce(join(outbox, `${draftId}.confirmation.json`), {
      ...confirmation,
      content_hash: sha256(confirmation),
    }, (existing) => {
      const parsed = parseHashedArtifact(humanConfirmationSchema, existing);
      return parsed.case_id === caseId && parsed.draft_id === draftId;
    });
    const parsedStored = parseHashedArtifact(humanConfirmationSchema, stored);
    const { content_hash: _contentHash, ...storedConfirmation } = parsedStored;
    return {
      ...storedConfirmation,
      evidence_ref: `human-confirmation:${storedConfirmation.draft_id}`,
    };
  };

  const recordComplaintEvidence = async ({
    caseId,
    caseWorkspaceRoot,
    sourceTypes,
    productMentions,
    observedIssueLabels,
    orderEvidenceStatus,
    emotion,
    evidenceRefs,
  }: {
    caseId: string;
    caseWorkspaceRoot: string;
    sourceTypes: Array<
      "EMAIL" | "PHOTO" | "ORDER_SCREENSHOT" | "VIDEO_KEYFRAME" | "TEXT"
    >;
    productMentions: string[];
    observedIssueLabels: string[];
    orderEvidenceStatus:
      | "NOT_PRESENT"
      | "SCREENSHOT_UNVERIFIED"
      | "LOOKUP_PENDING"
      | "VERIFIED_VIA_TOOL";
    emotion:
      | "CALM"
      | "CONFUSED"
      | "FRUSTRATED"
      | "ANGRY"
      | "DISTRESSED"
      | "UNKNOWN";
    evidenceRefs: string[];
  }) => {
    const identity = {
      case_id: caseId,
      source_types: [...new Set(sourceTypes)].sort(),
      product_mentions: productMentions,
      observed_issue_labels: observedIssueLabels,
      order_evidence_status: orderEvidenceStatus,
      emotion,
      evidence_refs: [...new Set(evidenceRefs)].sort(),
    };
    const recordId = sha256(identity).slice(0, 32);
    const record = complaintEvidenceBodySchema.parse({
      schema_version: "fixagent.complaint-evidence.v0",
      case_id: caseId,
      record_id: recordId,
      source_types: identity.source_types,
      product_mentions: identity.product_mentions,
      observed_issue_labels: identity.observed_issue_labels,
      order_evidence_status: identity.order_evidence_status,
      emotion: identity.emotion,
      evidence_refs: identity.evidence_refs,
      status: "AGENT_EXTRACTED_UNVERIFIED",
      created_at: now().toISOString(),
    });
    const evidenceDirectory = join(caseWorkspaceRoot, "complaint_evidence");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const stored = await writeOnce(join(evidenceDirectory, `${recordId}.json`), {
      ...record,
      content_hash: sha256(record),
    }, (existing) => {
      const parsed = parseHashedArtifact(complaintEvidenceSchema, existing);
      return parsed.case_id === caseId && parsed.record_id === recordId;
    });
    const parsedStored = parseHashedArtifact(complaintEvidenceSchema, stored);
    const { content_hash: _contentHash, ...storedRecord } = parsedStored;
    return {
      ...storedRecord,
      evidence_ref: `complaint:${storedRecord.record_id}`,
    };
  };

  return {
    datasetStatus: dataset.data_status,
    datasetHash: dataset.content_hash,
    resolveProductIdentity,
    getMaskedOrder,
    determineWarrantyStatus,
    verifyAuthorizedDealer,
    recordComplaintEvidence,
    createAfterSalesDraft,
    requestHumanConfirmation,
  };
};

export type AfterSalesService = ReturnType<typeof createAfterSalesService>;
