import {
  CompiledRule,
  Condition,
  InboundMessage,
  MatchField,
  MatchOp,
  RuleAction,
  evaluateRules,
  parseActions,
  parseMatch,
} from './rule-engine';

describe('rule engine', () => {
  const msg: InboundMessage = {
    fromAddress: 'Alice@Acme.com',
    toAddress: 'Support@Example.com',
    subject: 'Quarterly Invoice Ready',
  };

  const action = (type: RuleAction['type'], value?: string): RuleAction =>
    value === undefined ? { type } : { type, value };

  const rule = (
    id: string,
    priority: number,
    match: CompiledRule['match'],
    actions: RuleAction[],
    enabled = true,
  ): CompiledRule => ({
    id,
    enabled,
    priority,
    match,
    actions,
  });

  describe('single conditions', () => {
    const cases: Array<{
      field: MatchField;
      op: MatchOp;
      value: string;
    }> = [
      { field: 'from', op: 'equals', value: 'alice@acme.com' },
      { field: 'from', op: 'contains', value: '@acme' },
      { field: 'from', op: 'startsWith', value: 'alice' },
      { field: 'from', op: 'endsWith', value: 'acme.com' },
      { field: 'to', op: 'equals', value: 'support@example.com' },
      { field: 'to', op: 'contains', value: '@example' },
      { field: 'to', op: 'startsWith', value: 'support' },
      { field: 'to', op: 'endsWith', value: 'example.com' },
      { field: 'subject', op: 'equals', value: 'quarterly invoice ready' },
      { field: 'subject', op: 'contains', value: 'invoice' },
      { field: 'subject', op: 'startsWith', value: 'quarterly' },
      { field: 'subject', op: 'endsWith', value: 'ready' },
      { field: 'fromDomain', op: 'equals', value: 'acme.com' },
      { field: 'fromDomain', op: 'contains', value: 'acme' },
      { field: 'fromDomain', op: 'startsWith', value: 'acme' },
      { field: 'fromDomain', op: 'endsWith', value: '.com' },
    ];

    it.each(cases)('matches $field $op', ({ field, op, value }) => {
      const condition: Condition = { field, op, value };

      expect(
        evaluateRules([rule('r1', 1, { all: [condition] }, [action('LABEL', `${field}-${op}`)])], msg),
      ).toEqual([action('LABEL', `${field}-${op}`)]);
    });
  });

  it('requires every child in all', () => {
    const rules = [
      rule(
        'match',
        1,
        {
          all: [
            { field: 'from', op: 'contains', value: 'alice' },
            { field: 'subject', op: 'contains', value: 'invoice' },
          ],
        },
        [action('LABEL', 'matched')],
      ),
      rule(
        'miss',
        2,
        {
          all: [
            { field: 'from', op: 'contains', value: 'alice' },
            { field: 'subject', op: 'contains', value: 'missing' },
          ],
        },
        [action('LABEL', 'missed')],
      ),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('LABEL', 'matched')]);
  });

  it('requires one child in any', () => {
    const rules = [
      rule(
        'match',
        1,
        {
          any: [
            { field: 'from', op: 'contains', value: 'nobody' },
            { field: 'subject', op: 'contains', value: 'invoice' },
          ],
        },
        [action('LABEL', 'matched')],
      ),
      rule(
        'miss',
        2,
        {
          any: [
            { field: 'from', op: 'contains', value: 'nobody' },
            { field: 'subject', op: 'contains', value: 'missing' },
          ],
        },
        [action('LABEL', 'missed')],
      ),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('LABEL', 'matched')]);
  });

  it('supports nested AND-of-ORs', () => {
    const rules = [
      rule(
        'nested',
        1,
        {
          all: [
            {
              any: [
                { field: 'fromDomain', op: 'equals', value: 'other.com' },
                { field: 'fromDomain', op: 'equals', value: 'acme.com' },
              ],
            },
            {
              any: [
                { field: 'subject', op: 'contains', value: 'receipt' },
                { field: 'subject', op: 'contains', value: 'invoice' },
              ],
            },
          ],
        },
        [action('MOVE_TO_FOLDER', 'Finance')],
      ),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('MOVE_TO_FOLDER', 'Finance')]);
  });

  it('supports nested OR-of-ANDs (any of grouped alls)', () => {
    const rules = [
      rule(
        'nested-any',
        1,
        {
          any: [
            {
              all: [
                { field: 'fromDomain', op: 'equals', value: 'other.com' },
                { field: 'subject', op: 'contains', value: 'invoice' },
              ],
            },
            {
              all: [
                { field: 'fromDomain', op: 'equals', value: 'acme.com' },
                { field: 'subject', op: 'contains', value: 'invoice' },
              ],
            },
          ],
        },
        [action('ARCHIVE')],
      ),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('ARCHIVE')]);
  });

  it('mixes conditions and groups under one top-level node', () => {
    const rules = [
      rule(
        'mixed',
        1,
        {
          all: [
            { field: 'from', op: 'contains', value: 'alice' },
            {
              any: [
                { field: 'subject', op: 'contains', value: 'receipt' },
                { field: 'subject', op: 'contains', value: 'invoice' },
              ],
            },
          ],
        },
        [action('MARK_READ')],
      ),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('MARK_READ')]);
  });

  it('a node carrying BOTH all and any requires both clauses to hold (legacy rows)', () => {
    const both = (allValue: string, anyValue: string): CompiledRule['match'] => ({
      all: [{ field: 'from', op: 'contains', value: allValue }],
      any: [{ field: 'subject', op: 'contains', value: anyValue }],
    });

    // Both clauses hold → match.
    expect(
      evaluateRules([rule('r1', 1, both('alice', 'invoice'), [action('MARK_READ')])], msg),
    ).toEqual([action('MARK_READ')]);
    // The any-side fails → no match (it is never silently ignored).
    expect(evaluateRules([rule('r2', 1, both('alice', 'missing'), [action('MARK_READ')])], msg)).toEqual([]);
    // The all-side fails → no match.
    expect(evaluateRules([rule('r3', 1, both('nobody', 'invoice'), [action('MARK_READ')])], msg)).toEqual([]);
  });

  it('an EMPTY group matches NOTHING — it sinks its parent ALL and adds nothing to a parent ANY', () => {
    // A valid condition alongside an empty ANY group: the group contributes
    // false, so the enclosing ALL can never hold.
    const sunkAll = [
      rule(
        'sunk',
        1,
        { all: [{ field: 'from', op: 'contains', value: 'alice' }, { any: [] }] },
        [action('TRASH')],
      ),
    ];
    expect(evaluateRules(sunkAll, msg)).toEqual([]);

    // Under ANY, an empty ALL group is just a false branch — the sibling
    // condition still carries the match.
    const carried = [
      rule(
        'carried',
        1,
        { any: [{ all: [] }, { field: 'subject', op: 'contains', value: 'invoice' }] },
        [action('ARCHIVE')],
      ),
    ];
    expect(evaluateRules(carried, msg)).toEqual([action('ARCHIVE')]);
  });

  it('still evaluates legacy trees nested deeper than the one write-time group level', () => {
    const rules = [
      rule(
        'deep',
        1,
        {
          all: [
            {
              any: [
                {
                  all: [
                    { field: 'from', op: 'contains', value: 'alice' },
                    { field: 'subject', op: 'contains', value: 'invoice' },
                  ],
                },
                { field: 'fromDomain', op: 'equals', value: 'other.com' },
              ],
            },
          ],
        },
        [action('MOVE_TO_FOLDER', 'Deep')],
      ),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('MOVE_TO_FOLDER', 'Deep')]);
  });

  it('runs matched rules by ascending priority', () => {
    const rules = [
      rule('later', 20, { all: [{ field: 'subject', op: 'contains', value: 'invoice' }] }, [
        action('LABEL', 'later'),
      ]),
      rule('earlier', 10, { all: [{ field: 'from', op: 'contains', value: 'alice' }] }, [
        action('LABEL', 'earlier'),
      ]),
    ];

    expect(evaluateRules(rules, msg)).toEqual([
      action('LABEL', 'earlier'),
      action('LABEL', 'later'),
    ]);
  });

  it('STOP halts later rules but keeps its own actions', () => {
    const rules = [
      rule('first', 1, { all: [{ field: 'from', op: 'contains', value: 'alice' }] }, [
        action('LABEL', 'before-stop'),
        action('STOP'),
      ]),
      rule('second', 2, { all: [{ field: 'subject', op: 'contains', value: 'invoice' }] }, [
        action('LABEL', 'after-stop'),
      ]),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('LABEL', 'before-stop'), action('STOP')]);
  });

  it('skips disabled rules', () => {
    const rules = [
      rule(
        'disabled',
        1,
        { all: [{ field: 'from', op: 'contains', value: 'alice' }] },
        [action('LABEL', 'disabled')],
        false,
      ),
      rule('enabled', 2, { all: [{ field: 'subject', op: 'contains', value: 'invoice' }] }, [
        action('LABEL', 'enabled'),
      ]),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('LABEL', 'enabled')]);
  });

  it('treats malformed match as no match without throwing', () => {
    const malformedRules = [
      rule('null', 1, null as unknown as CompiledRule['match'], [action('LABEL', 'null')]),
      rule('unknown-field', 2, { all: [{ field: 'bad', op: 'equals', value: 'x' } as never] }, [
        action('LABEL', 'bad-field'),
      ]),
      rule('empty-all', 3, { all: [] }, [action('LABEL', 'empty-all')]),
      rule('empty-any', 4, { any: [] }, [action('LABEL', 'empty-any')]),
    ];

    expect(() => evaluateRules(malformedRules, msg)).not.toThrow();
    expect(evaluateRules(malformedRules, msg)).toEqual([]);
  });

  it('extracts fromDomain from the part after @', () => {
    const rules = [
      rule('domain', 1, { all: [{ field: 'fromDomain', op: 'equals', value: 'acme.com' }] }, [
        action('LABEL', 'domain'),
      ]),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('LABEL', 'domain')]);
  });

  it('matches case-insensitively', () => {
    const rules = [
      rule(
        'case',
        1,
        {
          all: [
            { field: 'from', op: 'equals', value: 'ALICE@ACME.COM' },
            { field: 'to', op: 'contains', value: 'SUPPORT' },
            { field: 'subject', op: 'contains', value: 'INVOICE' },
            { field: 'fromDomain', op: 'equals', value: 'ACME.COM' },
          ],
        },
        [action('MARK_READ')],
      ),
    ];

    expect(evaluateRules(rules, msg)).toEqual([action('MARK_READ')]);
  });

  it("matches 'to' against ANY real recipient when toAddresses is present", () => {
    const multi: InboundMessage = {
      fromAddress: 'list@acme.com',
      toAddress: '', // the applicator zeroes this so the fallback can't fire
      toAddresses: ['other@example.com', 'founder+lists@acme.test'],
      subject: 'Weekly digest',
    };
    const rules = [
      rule('r1', 10, { all: [{ field: 'to', op: 'contains', value: 'founder+lists' }] }, [
        action('ARCHIVE'),
      ]),
    ];
    expect(evaluateRules(rules, multi)).toEqual([action('ARCHIVE')]);
    // 'equals' must test each recipient individually, not a joined string.
    const eq = [
      rule('r2', 10, { all: [{ field: 'to', op: 'equals', value: 'other@example.com' }] }, [
        action('MARK_READ'),
      ]),
    ];
    expect(evaluateRules(eq, multi)).toEqual([action('MARK_READ')]);
  });

  it("matches NOTHING on 'to' when the real header is unknown (empty lists)", () => {
    const unknown: InboundMessage = {
      fromAddress: 'a@x.test',
      toAddress: '',
      toAddresses: [],
      subject: 'hi',
    };
    // Even an always-true-looking condition can't fire without a real To value —
    // the old bug matched the mailbox's own address stand-in on every message.
    const rules = [
      rule('r1', 10, { all: [{ field: 'to', op: 'contains', value: '@' }] }, [action('TRASH')]),
    ];
    expect(evaluateRules(rules, unknown)).toEqual([]);
  });

  it("keeps the single toAddress back-compat path for 'to' conditions", () => {
    // The legacy fixture (toAddress only, no toAddresses) still matches.
    const rules = [
      rule('r1', 10, { all: [{ field: 'to', op: 'equals', value: 'support@example.com' }] }, [
        action('MARK_READ'),
      ]),
    ];
    expect(evaluateRules(rules, msg)).toEqual([action('MARK_READ')]);
  });

  it('parseMatch tolerates unknown input into a safe empty match', () => {
    expect(parseMatch(null)).toEqual({});
    expect(parseMatch({ all: [{ field: 'from', op: 'equals', value: 'alice@acme.com' }] })).toEqual({
      all: [{ field: 'from', op: 'equals', value: 'alice@acme.com' }],
    });
  });

  it('parseActions tolerates unknown input and keeps only valid actions', () => {
    expect(parseActions(null)).toEqual([]);
    expect(
      parseActions([
        { type: 'LABEL', value: 'Finance' },
        { type: 'NOPE', value: 'Ignored' },
        { type: 'STOP' },
        { type: 'MOVE_TO_FOLDER', value: 123 },
      ]),
    ).toEqual([{ type: 'LABEL', value: 'Finance' }, { type: 'STOP' }, { type: 'MOVE_TO_FOLDER' }]);
  });
});
