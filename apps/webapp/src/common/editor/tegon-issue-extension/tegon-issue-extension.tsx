import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

import { VantikIssueComponent } from './vantik-issue-component';

export const vantikIssueExtension = Node.create({
  name: 'vantikIssueExtension',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      url: {
        default: undefined,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'vantik-issue-extension',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['vantik-issue-extension', mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VantikIssueComponent, {
      contentDOMElementTag: 'span',
      as: 'span',
    });
  },
});
