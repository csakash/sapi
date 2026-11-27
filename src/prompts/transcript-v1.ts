/**
 * Prompt template: how a multi-turn chat becomes one prompt for `claude -p` (ARI-42 EVAL-3,
 * INJ-3, INJ-5). The version string is logged with every request. Change the text only by adding
 * a new version file; never edit a released one.
 *
 * - A single user message is passed through unchanged; sapi adds nothing (DATA-2).
 * - Earlier turns are wrapped in role tags. Any role tag inside content is escaped first, so
 *   content can't close a turn or forge a new one.
 * - No secrets, keys or machine details ever go into a template.
 */
import type { CanonicalMessage } from "../canonical.ts";

export const TEMPLATE_VERSION = "transcript-v1";

const RESERVED_TAG = /<(?=\s*\/?\s*(?:user|assistant|conversation|system)\b)/gi;

/** Escape the "<" of anything that looks like one of the template's role tags. */
export function escapeRoleTags(text: string): string {
  return text.replace(RESERVED_TAG, "&lt;");
}

export function renderPrompt(messages: CanonicalMessage[]): string {
  if (messages.length === 0) throw new Error("no messages");
  const last = messages[messages.length - 1]!;
  if (last.role !== "user") throw new Error("the last message must be from the user");
  if (messages.length === 1) return last.text;

  const turns = messages
    .slice(0, -1)
    .map((m) => `<${m.role}>\n${escapeRoleTags(m.text)}\n</${m.role}>`)
    .join("\n");
  return [
    "Earlier turns of this conversation are in the conversation block below. Reply to the final user message as the assistant.",
    "",
    "<conversation>",
    turns,
    "</conversation>",
    "",
    "<user>",
    escapeRoleTags(last.text),
    "</user>",
  ].join("\n");
}
