import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SAFETY_FALLBACK_MESSAGE =
  "请停止操作该设备并等待人工处理。";
export const SAFETY_FALLBACK_TEMPLATE_ID = "UNIVERSAL_SAFETY_FALLBACK_V0";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const SAFETY_FALLBACK_MESSAGE_HASH = sha256(
  SAFETY_FALLBACK_MESSAGE,
);

const safetyRules = [
  { id: "SMOKE", pattern: /冒烟|烟雾|smok(?:e|ing)/iu },
  {
    id: "BURNT_ODOR_OR_MARK",
    pattern: /烧焦(?:气味|味)?|焦糊味|烧灼痕迹|burn(?:t|ing)\s+(?:smell|mark)/iu,
  },
  {
    id: "SEVERE_OVERHEAT",
    pattern: /严重(?:或持续)?过热|持续(?:严重)?过热|烫得无法触碰|severe(?:ly)?\s+overheat/iu,
  },
  {
    id: "BATTERY_ABNORMAL",
    pattern:
      /电池.{0,8}(?:鼓包|膨胀|变形|异常)|(?:鼓包|膨胀|变形).{0,8}电池|swollen\s+battery/iu,
  },
  {
    id: "EXPOSED_OR_HOT_WIRE",
    pattern:
      /(?:裸露|破损|发热).{0,8}(?:线路|电线|线束)|(?:线路|电线|线束).{0,8}(?:裸露|破损|发热)/u,
  },
] as const;

export interface SafetyTrigger {
  ruleIds: string[];
}

export const detectSafetyRedline = (message: string): SafetyTrigger | null => {
  const positiveClauses = message
    .split(/[，。；！？,;!\n]|但是|但|却|而是/gu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause) => {
      const uncertain =
        /不知道|不确定|不能确定|无法确认|不能确认|是否|有没有|疑似|可能|not sure|uncertain|unknown|whether|suspected|maybe|might/iu.test(
          clause,
        );
      if (uncertain) return true;
      return (
        !/(?:没有|并未|并无|未见|未闻到|不曾|不是|无)(?=.{0,16}(?:冒烟|烟雾|烧焦|焦糊|烧灼|过热|鼓包|膨胀|变形|裸露|破损|发热线路|液体进入|进水|液体渗入))/u.test(
          clause,
        ) &&
        !/不严重过热|不持续过热/u.test(clause) &&
        !/\b(?:no|not|without)\b(?=.{0,40}(?:smok(?:e|ing)|burn(?:t|ing)|overheat|swollen\s+battery))/iu.test(
          clause,
        )
      );
    });
  const normalized = positiveClauses.join("，");
  const ruleIds: string[] = safetyRules
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ id }) => id);

  const liquidIngress = /液体进入|进水|液体渗入|liquid ingress/iu.test(
    normalized,
  );
  const poweredAbnormal =
    /(?:通电|上电|开机).{0,8}(?:异常|冒烟|发热)|(?:异常|冒烟|发热).{0,8}(?:通电|上电|开机)/u.test(
      normalized,
    );
  if (liquidIngress && poweredAbnormal) {
    ruleIds.push("LIQUID_POWERED_ABNORMAL");
  }

  return ruleIds.length > 0 ? { ruleIds } : null;
};

export interface SafetyHandoff {
  id: string;
  status: "SIMULATED_NOT_CONTACTED";
}

const deterministicHandoffId = (idempotencyKey: string): string => {
  const hex = idempotencyKey.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const createSafetyHandoff = async ({
  caseId,
  caseWorkspaceRoot,
  trigger,
}: {
  caseId: string;
  caseWorkspaceRoot: string;
  trigger: SafetyTrigger;
}): Promise<SafetyHandoff> => {
  const idempotencyKey = sha256(
    JSON.stringify([caseId, [...trigger.ruleIds].sort()]),
  );
  const id = deterministicHandoffId(idempotencyKey);
  const outbox = join(caseWorkspaceRoot, "handoff_outbox");
  await mkdir(outbox, { recursive: true, mode: 0o700 });
  const destination = join(outbox, `${id}.json`);
  try {
    const existing = JSON.parse(await readFile(destination, "utf8")) as {
      case_id?: string;
      idempotency_key?: string;
      handoff_type?: string;
    };
    if (
      existing.case_id !== caseId ||
      existing.idempotency_key !== idempotencyKey ||
      existing.handoff_type !== "SAFETY_HANDOFF"
    ) {
      throw new Error("HANDOFF_IDEMPOTENCY_CONFLICT");
    }
    return { id, status: "SIMULATED_NOT_CONTACTED" };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const createdAt = new Date().toISOString();
  const packetWithoutHash = {
    schema_version: "fixagent.handoff.v0",
    case_id: caseId,
    handoff_id: id,
    idempotency_key: idempotencyKey,
    handoff_type: "SAFETY_HANDOFF",
    status: "SIMULATED_NOT_CONTACTED",
    created_at: createdAt,
    trigger_source: "APPROVED_TEXT_RULE",
    trigger_rule_ids: trigger.ruleIds,
    template_id: SAFETY_FALLBACK_TEMPLATE_ID,
    message: SAFETY_FALLBACK_MESSAGE,
    message_hash: SAFETY_FALLBACK_MESSAGE_HASH,
  } as const;
  const packet = {
    ...packetWithoutHash,
    content_hash: sha256(JSON.stringify(packetWithoutHash)),
  };
  const temporary = join(outbox, `.${id}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(packet, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, destination);

  return { id, status: "SIMULATED_NOT_CONTACTED" };
};
