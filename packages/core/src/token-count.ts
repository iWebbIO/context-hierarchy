import { getEncoding } from "js-tiktoken";

// cl100k_base encoding, loaded once per process and reused.
let encoding: ReturnType<typeof getEncoding> | undefined;

function encoder(): ReturnType<typeof getEncoding> {
  if (!encoding) encoding = getEncoding("cl100k_base");
  return encoding;
}

/** Deterministic cl100k_base token count for a string. */
export function countTokens(text: string): number {
  return encoder().encode(text).length;
}
