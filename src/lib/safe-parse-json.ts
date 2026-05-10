/**
 * Attempts to parse a string as JSON. If standard parsing fails,
 * falls back to extracting the first JSON-like object from the string.
 */
export function safeParseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`[${label}] response not JSON: ${content.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}
