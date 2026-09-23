import { z } from "zod";

export class FixAgentDomainError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FixAgentDomainError";
  }
}

export const domainErrorCode = (
  error: unknown,
  fallback: string,
): string => {
  if (error instanceof FixAgentDomainError) return error.code;
  if (error instanceof z.ZodError) return "SCHEMA_VALIDATION_FAILED";
  if (error instanceof Error) {
    return /^[A-Z][A-Z0-9_]*(?=[:\s]|$)/u.exec(error.message)?.[0] ?? fallback;
  }
  return fallback;
};
