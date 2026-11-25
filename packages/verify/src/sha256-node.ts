import { createHash } from "node:crypto";

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex characters (node:crypto). */
export function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
