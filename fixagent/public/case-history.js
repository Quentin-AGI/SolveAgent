const storageKey = "fixagent.case-history.v1";
const maximumCases = 8;
const caseIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cleanString = (value, maximumLength) =>
  typeof value === "string" ? value.slice(0, maximumLength) : undefined;

const normalizeMessage = (candidate) => {
  if (!candidate || typeof candidate !== "object") return undefined;
  if (candidate.role !== "user" && candidate.role !== "agent") return undefined;
  const text = cleanString(candidate.text, 100_000);
  if (text === undefined) return undefined;

  return {
    role: candidate.role,
    text,
    error: candidate.error === true,
    attachments: Array.isArray(candidate.attachments)
      ? candidate.attachments
          .filter((name) => typeof name === "string")
          .slice(0, 4)
          .map((name) => name.slice(0, 180))
      : [],
  };
};

const normalizeCase = (candidate) => {
  if (!candidate || typeof candidate !== "object") return undefined;
  const id = cleanString(candidate.id, 64);
  const title = cleanString(candidate.title, 80);
  const status = cleanString(candidate.status, 240);
  const updatedAt = Number(candidate.updatedAt);
  if (
    !id ||
    !caseIdPattern.test(id) ||
    !title ||
    !status ||
    !Number.isFinite(updatedAt)
  ) {
    return undefined;
  }

  const messages = Array.isArray(candidate.messages)
    ? candidate.messages.map(normalizeMessage).filter(Boolean)
    : [];
  const providerProfileId = cleanString(candidate.providerProfileId, 100);

  return {
    id,
    title,
    status,
    messages,
    ...(providerProfileId ? { providerProfileId } : {}),
    updatedAt,
  };
};

const normalizeHistory = (candidate) => {
  if (!Array.isArray(candidate)) return [];
  const unique = new Map();
  for (const entry of candidate) {
    const record = normalizeCase(entry);
    if (!record || unique.has(record.id)) continue;
    unique.set(record.id, record);
  }
  return [...unique.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, maximumCases);
};

export function loadCaseHistory(storage) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKey);
    return raw ? normalizeHistory(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveCaseHistory(storage, cases) {
  if (!storage) return false;
  const records = normalizeHistory(cases);
  if (records.length === 0) {
    try {
      storage.setItem(storageKey, "[]");
      return true;
    } catch {
      return false;
    }
  }
  for (let retained = records.length; retained >= 1; retained -= 1) {
    try {
      storage.setItem(storageKey, JSON.stringify(records.slice(0, retained)));
      return true;
    } catch {
      // A full browser quota should discard only the oldest Case, never the newest.
    }
  }
  return false;
}
