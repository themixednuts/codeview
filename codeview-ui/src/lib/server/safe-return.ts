import * as Predicate from "effect/Predicate";

export function safeReturnPath(value: FormDataEntryValue | string | null | undefined): string {
  if (!Predicate.isString(value) || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://codeview.invalid");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
