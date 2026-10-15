import { z } from "zod";

export class FixAgentDomainError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "FixAgentDomainError";
  }
}

export const domainErrorCode = (
  error: unknown,
  fallback: string,
): string => {
  if (error instanceof FixAgentDomainError) return error.code;
  if (error instanceof z.ZodError) return "SCHEMA_VALIDATION_FAILED";
  return fallback;
};

export interface SerializedFixAgentError {
  message: string;
  code?: string;
}

const domainCodePattern = /^[A-Z][A-Z0-9_]*$/u;

export const serializeFixAgentError = (
  error: unknown,
  fallbackMessage: string,
): SerializedFixAgentError => ({
  message: error instanceof Error ? error.message : fallbackMessage,
  ...(error instanceof FixAgentDomainError ? { code: error.code } : {}),
});

export const deserializeFixAgentError = ({
  message,
  code,
}: SerializedFixAgentError): Error => {
  if (!code || !domainCodePattern.test(code)) return new Error(message);
  const detailPrefix = `${code}: `;
  return new FixAgentDomainError(
    code,
    message.startsWith(detailPrefix)
      ? message.slice(detailPrefix.length)
      : undefined,
  );
};
