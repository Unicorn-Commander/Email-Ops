export interface ParsedSearch {
  text: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
  isRead?: boolean;
  isStarred?: boolean;
  before?: string;
  after?: string;
}

const KNOWN_KEYS = new Set(['from', 'to', 'cc', 'subject', 'has', 'is', 'before', 'after']);

function unquote(s: string): string {
  if (s.length >= 2) {
    if (s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
    if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
  }
  return s;
}

function extractTokens(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue; }
    // Read one whitespace-delimited token, but a double-quote opens a span that
    // swallows whitespace until its closing quote — so both `"a b"` and
    // `subject:"a b"` stay a SINGLE token (the operator's quoted value keeps its
    // spaces). An unterminated quote runs to end-of-input (→ treated as free text).
    let token = '';
    while (i < input.length && !/\s/.test(input[i])) {
      if (input[i] === '"') {
        token += '"';
        i++;
        while (i < input.length && input[i] !== '"') { token += input[i]; i++; }
        if (i < input.length) { token += '"'; i++; }
      } else {
        token += input[i];
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

function parseOperator(token: string): { key: string; value: string } | null {
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) return null;
  const key = token.slice(0, colonIdx).toLowerCase();
  if (!KNOWN_KEYS.has(key)) return null;
  let value = token.slice(colonIdx + 1);
  if (!value) return null;
  if (value[0] === '"' || value[0] === "'") {
    if (value.length < 2 || value[0] !== value[value.length - 1]) return null;
  }
  value = unquote(value);
  if (!value) return null;
  return { key, value };
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function parseSearchQuery(q: string | null | undefined): ParsedSearch {
  const result: ParsedSearch = { text: '' };
  if (!q) return result;
  const tokens = extractTokens(q.trim());
  const freeText: string[] = [];
  for (const token of tokens) {
    const op = parseOperator(token);
    if (!op) {
      freeText.push(unquote(token));
      continue;
    }
    switch (op.key) {
      case 'from':
        result.from = op.value;
        break;
      case 'to':
        result.to = op.value;
        break;
      case 'cc':
        result.cc = op.value;
        break;
      case 'subject':
        result.subject = op.value;
        break;
      case 'has':
        if (op.value === 'attachment') result.hasAttachment = true;
        else freeText.push(unquote(token));
        break;
      case 'is':
        const val = op.value.toLowerCase();
        if (val === 'unread') result.isUnread = true;
        else if (val === 'read') result.isRead = true;
        else if (val === 'starred' || val === 'flagged') result.isStarred = true;
        else freeText.push(unquote(token));
        break;
      case 'before':
        if (isValidDate(op.value)) result.before = op.value;
        else freeText.push(unquote(token));
        break;
      case 'after':
        if (isValidDate(op.value)) result.after = op.value;
        else freeText.push(unquote(token));
        break;
    }
  }
  result.text = freeText.join(' ');
  return result;
}

export function buildJmapFilter(
  parsed: ParsedSearch,
  inMailboxId?: string | null
): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];
  if (parsed.text) conditions.push({ text: parsed.text });
  if (parsed.from) conditions.push({ from: parsed.from });
  if (parsed.to) conditions.push({ to: parsed.to });
  if (parsed.cc) conditions.push({ cc: parsed.cc });
  if (parsed.subject) conditions.push({ subject: parsed.subject });
  if (parsed.hasAttachment) conditions.push({ hasAttachment: true });
  // Read/flag state is a JMAP keyword filter, NOT a bare FilterCondition prop:
  // RFC 8621 has no `isUnread`/`isStarred` — James stores `$seen`/`$flagged`
  // (see james.client: `keywords['$seen']`, `keywords/$flagged`). Map to the
  // standard hasKeyword/notKeyword so the server actually filters.
  if (parsed.isUnread) conditions.push({ notKeyword: '$seen' });
  if (parsed.isRead) conditions.push({ hasKeyword: '$seen' });
  if (parsed.isStarred) conditions.push({ hasKeyword: '$flagged' });
  if (parsed.before) conditions.push({ before: parsed.before + 'T00:00:00Z' });
  if (parsed.after) conditions.push({ after: parsed.after + 'T00:00:00Z' });
  if (inMailboxId) conditions.push({ inMailbox: inMailboxId });
  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { operator: 'AND', conditions };
}
