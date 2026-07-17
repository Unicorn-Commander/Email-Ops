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
