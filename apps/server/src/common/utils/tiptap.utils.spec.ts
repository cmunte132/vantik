import {
  convertMarkdownToTiptapJson,
  convertTiptapJsonToMarkdown,
  convertTiptapJsonToText,
} from './tiptap.utils';

const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

const marked = (mark: string, text = 'marked') => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: 'plain ' },
    { type: 'text', marks: [{ type: mark }], text },
  ],
});

describe('convertTiptapJsonToMarkdown', () => {
  it('converts plain rich text', () => {
    expect(
      convertTiptapJsonToMarkdown(
        doc({
          type: 'paragraph',
          content: [{ type: 'text', text: 'Nightly job saturates the pool' }],
        }),
      ),
    ).toBe('Nightly job saturates the pool');
  });

  // A mark with no registered extension makes tiptap throw, which the
  // converter swallows into '' — content silently disappears rather than
  // erroring. Every mark the editor can emit has to round-trip.
  it.each(['bold', 'italic', 'strike', 'underline', 'highlight'])(
    'does not blank content carrying a %s mark',
    (mark) => {
      const markdown = convertTiptapJsonToMarkdown(doc(marked(mark)));

      expect(markdown).not.toBe('');
      expect(markdown).toContain('plain');
      expect(markdown).toContain('marked');
    },
  );

  // The editor stores `id` as the mention's identity and `label` only as a
  // snapshot of the name. Tiptap renders `label ?? id`, so an unlabelled
  // mention serialises as a raw UUID — see mention-list.tsx.
  it('renders a mention as the name, not the user id', () => {
    const markdown = convertTiptapJsonToMarkdown(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'ping ' },
          { type: 'mention', attrs: { id: 'user-1', label: 'Jane Doe' } },
        ],
      }),
    );

    expect(markdown).toContain('@Jane Doe');
    expect(markdown).not.toContain('user-1');
  });

  it('renders structural nodes', () => {
    const markdown = convertTiptapJsonToMarkdown(
      doc(
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Root cause' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'pool too small' }],
                },
              ],
            },
          ],
        },
      ),
    );

    expect(markdown).toContain('## Root cause');
    expect(markdown).toContain('pool too small');
  });

  it('preserves inline code verbatim instead of escaping it as prose', () => {
    const markdown = convertTiptapJsonToMarkdown(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Set ' },
          {
            type: 'text',
            text: 'max_connections',
            marks: [{ type: 'code' }],
          },
        ],
      }),
    );

    // Without the Code mark registered the underscore came back escaped
    // (`max\_connections`), which is what an agent would have had to parse.
    expect(markdown).toContain('`max_connections`');
    expect(markdown).not.toContain('max\\_connections');
  });

  it('returns an empty string for empty input rather than throwing', () => {
    expect(convertTiptapJsonToMarkdown('')).toBe('');
  });

  // Returning '' on failure is indistinguishable from an issue with no
  // description, which is how several schema faults went unnoticed. Degrade to
  // plain text instead so the caller loses formatting, never content.
  it('falls back to plain text when the document cannot be converted', () => {
    expect(convertTiptapJsonToMarkdown('not json')).toBe('not json');

    const unknownMark = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'keep me', marks: [{ type: 'unknownMark' }] },
      ],
    });
    expect(convertTiptapJsonToMarkdown(unknownMark)).toBe('keep me');
  });
});

describe('convertMarkdownToTiptapJson', () => {
  // gfm and breaks are tokenizer options; supplying them only to the parser
  // leaves them inert and the syntax survives as literal text.
  it('parses GFM strikethrough rather than leaving the tildes', () => {
    const tiptap = convertMarkdownToTiptapJson('seen on ~~staging~~ only');
    const marks = JSON.stringify(tiptap);

    expect(marks).toContain('"strike"');
    expect(marks).not.toContain('~~');
  });

  it('treats a single newline as a line break', () => {
    const tiptap = convertMarkdownToTiptapJson('first line\nsecond line');

    expect(JSON.stringify(tiptap)).toContain('hardBreak');
  });

  it('round-trips formatting back to markdown', () => {
    const source =
      '## Root cause\n\nBumped the **pool** size, ~~reverted~~ and *retried*.';

    const markdown = convertTiptapJsonToMarkdown(
      JSON.stringify(convertMarkdownToTiptapJson(source)),
    );

    expect(markdown).toContain('## Root cause');
    expect(markdown).toContain('**pool**');
    expect(markdown).toContain('_retried_');
    expect(markdown).toContain('~~reverted~~');
  });
});

// This text is what gets indexed for search, so anything dropped here is
// content that becomes permanently unfindable.
describe('convertTiptapJsonToText', () => {
  it('keeps a marked-up sentence on one line', () => {
    const text = convertTiptapJsonToText(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'text', marks: [{ type: 'bold' }], text: 'nightly job' },
          { type: 'text', text: ' saturates the pool.' },
        ],
      }),
    );

    expect(text).toBe('The nightly job saturates the pool.');
  });

  it('includes list items', () => {
    const text = convertTiptapJsonToText(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'seen on production' }],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'starts at 02:00 UTC' }],
              },
            ],
          },
        ],
      }),
    );

    expect(text).toContain('seen on production');
    expect(text).toContain('starts at 02:00 UTC');
  });

  it('includes task list items and mentions', () => {
    const text = convertTiptapJsonToText(
      doc(
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'bump the pool' }],
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ping ' },
            { type: 'mention', attrs: { id: 'u1', label: 'Jane Doe' } },
          ],
        },
      ),
    );

    expect(text).toContain('bump the pool');
    expect(text).toContain('@Jane Doe');
  });

  it('recurses into unknown block types instead of dropping them', () => {
    const text = convertTiptapJsonToText(
      doc({
        type: 'someFutureBlock',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'still searchable' }],
          },
        ],
      }),
    );

    expect(text).toBe('still searchable');
  });
});
