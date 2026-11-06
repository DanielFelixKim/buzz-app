import { plainText } from "../notifications/content";

/** A compact excerpt: stop before an empty paragraph rather than clamping a blank line. */
export function messagePreviewText(content: string): string {
  const text = content.trim();
  const paragraphBreak = /\r?\n[^\S\r\n]*\r?\n/.exec(text);
  return paragraphBreak
    ? `${text.slice(0, paragraphBreak.index).trimEnd()}…`
    : text;
}

/** The excerpt's rendered prose on one line: no Markdown syntax or spoiler text. */
export const activityPreviewText = (content: string) =>
  plainText(messagePreviewText(content), { limit: 280 });
