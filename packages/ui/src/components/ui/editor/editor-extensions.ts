import { Extension, mergeAttributes } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import Heading from '@tiptap/extension-heading';
import HighlightExtension from '@tiptap/extension-highlight';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import TiptapLink from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { cx } from 'class-variance-authority';
import { Markdown as MarkdownExtension } from 'tiptap-markdown';

import { fileExtension } from './file-extension';
import { imageExtension } from './image-extension';
import { AIHighlight } from './primitives';

const tiptapLink = TiptapLink.configure({
  HTMLAttributes: {
    class: cx('text-primary cursor-pointer'),
  },
});

const taskList = TaskList.configure({
  HTMLAttributes: {
    class: cx('not-prose'),
  },
});

const taskItem = TaskItem.configure({
  HTMLAttributes: {
    class: cx('flex items-start gap-1 my-2'),
  },
  nested: true,
});

const horizontalRule = HorizontalRule.configure({
  HTMLAttributes: {
    class: cx('mt-4 mb-6 border-t border-muted-foreground'),
  },
});

const heading = Heading.extend({
  renderHTML({ node, HTMLAttributes }) {
    const hasLevel = this.options.levels.includes(node.attrs.level);
    const level: 1 | 2 | 3 = hasLevel
      ? node.attrs.level
      : this.options.levels[0];
    const levelMap = { 1: 'text-xl', 2: 'text-lg', 3: 'text-md' };

    return [
      `h${level}`,
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: `h${node.attrs.level}-style ${levelMap[level]} my-2`,
      }),
      0,
    ];
  },
}).configure({ levels: [1, 2, 3] });

const starterKit = StarterKit.configure({
  heading: false,
  codeBlock: false,
  // StarterKit bundles Link in v3; we add our own configured instance below
  link: false,
  bulletList: {
    HTMLAttributes: {
      class: cx('list-disc list-outside leading-3 pl-4'),
    },
  },
  orderedList: {
    HTMLAttributes: {
      class: cx('list-decimal list-outside pl-8 leading-3'),
    },
  },
  listItem: {
    HTMLAttributes: {
      class: cx('leading-normal'),
    },
  },
  blockquote: {
    HTMLAttributes: {
      class: cx('border-l-4 border-gray-400 dark:border-gray-500'),
    },
  },
  // Inline code is on because the API is a markdown boundary: an agent writing
  // `max_connections` must get it back verbatim. With the mark disabled the
  // editor's schema dropped it on ingest and the identifier came back as
  // escaped prose (`max\_connections`).
  code: {
    HTMLAttributes: {
      class: cx(
        'rounded-sm bg-grayAlpha-100 text-[#BF4594] px-1 py-0.5 font-mono font-medium text-sm box-decoration-clone',
      ),
    },
  },
  horizontalRule: false,
  dropcursor: {
    color: 'oklch(60% 0.13 240)',
    width: 4,
  },
  gapcursor: false,
});

const markdown = MarkdownExtension.configure({
  html: true, // Allow HTML input/output
  breaks: true,
});

const defaultPlaceholder = Placeholder.configure({
  placeholder: ({ node }) => {
    if (node.type.name === 'heading') {
      return `Heading ${node.attrs.level}`;
    }
    if (node.type.name === 'image' || node.type.name === 'table') {
      return '';
    }
    if (node.type.name === 'codeBlock') {
      return 'Type in your code here...';
    }

    return 'Describe your issue...';
  },
  includeChildren: true,
});

export const getPlaceholder = (placeholder: string | Extension) => {
  if (!placeholder) {
    return defaultPlaceholder;
  }

  if (typeof placeholder === 'string') {
    return Placeholder.configure({
      placeholder: () => {
        return placeholder;
      },
      includeChildren: true,
    });
  }

  return placeholder;
};

const codeBlock = CodeBlock.configure({
  HTMLAttributes: {
    class: cx(
      'rounded-md bg-grayAlpha-100 text-[#BF4594] px-1.5 py-1 font-mono font-medium border-none box-decoration-clone',
    ),
  },
});

export const defaultExtensions = [
  starterKit,
  tiptapLink,
  taskList,
  taskItem,
  horizontalRule,
  heading,
  AIHighlight,
  fileExtension,
  imageExtension,
  markdown,
  codeBlock,
  HighlightExtension,
];
