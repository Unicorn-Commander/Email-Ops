import { createHash } from 'node:crypto';
import { FetchMessageObject, MessageStructureObject } from 'imapflow';

export function references(message: FetchMessageObject): string[] {
  const headers = message.headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') ?? '';
  const value = /^references:\s*(.*)$/im.exec(headers)?.[1] ?? '';
  return value.match(/<[^<>\s]+>/g) ?? [];
}

/** Connected components include absent ancestors and merge out-of-order replies. */
export function groupMessages(messages: FetchMessageObject[], validity: string) {
  const parents = new Map<string, string>();
  const hasParent = new Set<string>();
  const ownId = (m: FetchMessageObject) => m.envelope?.messageId || `uid:${m.uid}`;
  const root = (id: string): string => {
    let current = id;
    while (parents.has(current) && parents.get(current) !== current)
      current = parents.get(current)!;
    return current;
  };
  for (const message of messages) {
    const chain = [
      ...references(message),
      ...(message.envelope?.inReplyTo?.match(/<[^<>\s]+>/g) ?? []),
      ownId(message),
    ];
    const ids = [...new Set(chain)];
    for (const id of ids) if (!parents.has(id)) parents.set(id, id);
    for (const id of ids.slice(1)) {
      hasParent.add(id);
      parents.set(root(id), root(ids[0]));
    }
  }
  const components = new Map<string, string[]>();
  for (const id of parents.keys()) {
    const key = root(id);
    components.set(key, [...(components.get(key) ?? []), id]);
  }
  const groups = new Map<string, FetchMessageObject[]>();
  for (const message of messages) {
    const component = components.get(root(ownId(message)))!;
    const ancestors = component.filter((id) => !hasParent.has(id));
    const canonical = (ancestors.length ? ancestors : component).slice().sort()[0];
    const id = `imap-${validity}-${createHash('sha256').update(canonical).digest('hex')}`;
    const group = groups.get(id) ?? [];
    group.push(message);
    groups.set(id, group);
  }
  return groups;
}

export function bodyParts(node?: MessageStructureObject): {
  body: MessageStructureObject[];
  attachments: MessageStructureObject[];
} {
  const result: ReturnType<typeof bodyParts> = { body: [], attachments: [] };
  if (!node) return result;
  const attachment =
    node.disposition === 'attachment' ||
    !!node.dispositionParameters?.filename ||
    !!node.parameters?.name;
  if (
    attachment ||
    (!node.childNodes?.length && !['text/plain', 'text/html'].includes(node.type))
  ) {
    result.attachments.push({ ...node, part: node.part || '1' });
  } else if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const parts = bodyParts(child);
      result.body.push(...parts.body);
      result.attachments.push(...parts.attachments);
    }
  } else result.body.push({ ...node, part: node.part || '1' });
  return result;
}
