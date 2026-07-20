import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { BulletList } from '@tiptap/extension-bullet-list';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { Highlight } from '@tiptap/extension-highlight';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Image } from '@tiptap/extension-image';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { ListItem } from '@tiptap/extension-list-item';
import { Mention } from '@tiptap/extension-mention';
import { OrderedList } from '@tiptap/extension-ordered-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { Text } from '@tiptap/extension-text';
import { Underline } from '@tiptap/extension-underline';
// The default `@tiptap/html` entry point is the browser build and throws in
// Node ("generateHTML can only be used in a browser environment"). The /server
// entry point runs the same conversion on happy-dom instead.
import { generateHTML, generateJSON } from '@tiptap/html/server';
import { marked } from 'marked';
import TurndownService from 'turndown';

import {
  TiptapListTypes,
  TiptapMarks,
  TiptapNode,
} from 'common/common.interface';

/**
 * The schema used to convert between Tiptap JSON, HTML and markdown.
 *
 * This must stay in step with the editor's extension list in
 * `packages/ui/src/components/ui/editor/editor-extensions.ts`: Tiptap throws
 * on any mark or node it has no extension for ("There is no mark type bold in
 * this schema"), and `convertTiptapJsonToMarkdown` swallows that into an empty
 * string, so a missing extension silently blanks the content rather than
 * failing loudly. The marks below come from the editor's StarterKit.
 *
 * `Code` is deliberately absent — the editor configures StarterKit with
 * `code: false`, so registering it here would let the API store inline code
 * marks the editor cannot render.
 */
const tiptapExtensions = [
  Document,
  Text,
  Paragraph,
  Heading,
  Blockquote,
  ListItem,
  OrderedList,
  BulletList,
  TaskList,
  TaskItem,
  Image,
  CodeBlock,
  HardBreak,
  HorizontalRule,
  Link,
  Underline,
  Bold,
  Italic,
  Strike,
  Highlight,
  Mention,
];

/**
 * Turndown defaults to setext headings (`Title` underlined with `---`, which
 * only expresses two levels) and indented code blocks. Both are legal markdown
 * but awkward for the API's consumers, so the output is pinned to the ATX and
 * fenced styles everything else in the product writes.
 */
function buildTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  // Turndown ships no rule for strikethrough, so tiptap's <s> would come back
  // as bare text and a ~~struck~~ round-trip would quietly lose its marker.
  service.addRule('strikethrough', {
    filter: ['del', 's'],
    replacement: (content) => (content ? `~~${content}~~` : ''),
  });

  return service;
}

export function convertTiptapJsonToText(
  tiptapJson: string | null | undefined,
): string {
  if (!tiptapJson) {
    return '';
  }

  try {
    const parsedJson = JSON.parse(tiptapJson);
    if (parsedJson.type !== 'doc' || !Array.isArray(parsedJson.content)) {
      return tiptapJson;
    }
    return extractTextFromNodes(parsedJson.content);
  } catch (error) {
    return tiptapJson;
  }
}

/**
 * Flattens a block of nodes to plain text, one line per block.
 *
 * This feeds the search index, so anything dropped here is content nobody can
 * search for. Node names are matched in tiptap's camelCase — an earlier
 * snake_case spelling (`bullet_list`) matched nothing, which silently kept
 * every list out of the index.
 */
function extractTextFromNodes(nodes: TiptapNode[]): string {
  return nodes
    .map((node) => extractTextFromNode(node))
    .filter((text) => text !== '')
    .join('\n');
}

function extractTextFromNode(node: TiptapNode): string {
  switch (node.type) {
    case 'text':
      return node.text || '';
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
      return extractInlineText(node.content || []);
    case 'blockquote':
      return extractTextFromNodes(node.content || []);
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (node.content || [])
        .map(
          (item) =>
            `- ${extractTextFromNodes(item.content || []).replace(/\n/g, ' ')}`,
        )
        .join('\n');
    case 'listItem':
    case 'taskItem':
      return extractTextFromNodes(node.content || []);
    case 'image':
      return node.attrs?.alt || '';
    default:
      // Unknown block: recurse rather than drop, so a node type added to the
      // editor later is still searchable before anyone updates this switch.
      return node.content ? extractTextFromNodes(node.content) : '';
  }
}

/**
 * Text inside a single block. Marked runs (bold, links, code) are separate
 * text nodes, so these must be concatenated — joining them with newlines
 * breaks sentences apart mid-phrase.
 */
function extractInlineText(nodes: TiptapNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text || '';
        case 'hardBreak':
          return '\n';
        case 'mention':
          return node.attrs?.label ? `@${node.attrs.label}` : '';
        case 'image':
          return node.attrs?.alt || '';
        default:
          return extractInlineText(node.content || []);
      }
    })
    .join('');
}

export function convertMarkdownToTiptapJsonOld(markdown: string): string {
  // Split the markdown string into an array of lines
  const lines = markdown.split('\n');
  // Initialize an array to store the parsed content
  const content: TiptapNode[] = [];

  // Initialize a variable to store the current node being parsed
  let currentNode: TiptapNode = { type: 'paragraph', content: [] };
  // Initialize a variable to store the current list type (if any)
  let listType: TiptapListTypes = null;

  // Iterate over each line of the markdown
  lines.forEach((line) => {
    // Trim any leading/trailing whitespace from the line
    line = line.trim();

    if (line === '') {
      // If the current node has content, push it to the content array and reset the current node
      if (currentNode.content.length > 0) {
        content.push(currentNode);
        currentNode = { type: 'paragraph', content: [] };
      }
    } else if (line.startsWith('```')) {
      // If the current node is a code block, push it to the content array and reset the current node
      if (currentNode.type === 'codeBlock') {
        content.push(currentNode);
        currentNode = { type: 'paragraph', content: [] };
        // Otherwise, start a new code block node
      } else {
        currentNode = { type: 'codeBlock', content: [] };
      }
    } else if (line.startsWith('#')) {
      // Determine the heading level based on the number of # characters
      const level = line.split(' ')[0].length;
      // Extract the heading text
      const text = line.slice(level + 1);
      // Push a new heading node to the content array
      content.push({
        type: `heading`,
        attrs: { level },
        content: [{ type: 'text', text }],
      });
    } else if (line.startsWith('>')) {
      // Extract the blockquote text
      const text = line.slice(2);
      // If the current node is a blockquote, append the text as a new paragraph
      if (currentNode.type === 'blockquote') {
        currentNode.content.push({
          type: 'paragraph',
          content: [{ type: 'text', text }],
        });
      } else {
        content.push(currentNode);
        currentNode = {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        };
      }
      // If the line starts with an ordered list delimiter (number followed by a period)
    } else if (line.match(/^\d+\./)) {
      // Extract the list item text
      const text = line.slice(line.indexOf('.') + 2);
      // If the current list type is an ordered list, append the list item to the current node
      if (listType === 'orderedList') {
        currentNode.content.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        });
        // Otherwise, push the current node to the content array and start a new ordered list node
      } else {
        content.push(currentNode);
        currentNode = {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text }] },
              ],
            },
          ],
        };
        listType = 'orderedList';
      }
    } else if (line.startsWith('-') || line.startsWith('*')) {
      // Extract the list item text
      const text = line.slice(2);
      // If the current list type is a bullet list, append the list item to the current node
      if (listType === 'bulletList') {
        currentNode.content.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        });
        // Otherwise, push the current node to the content array and start a new bullet list node
      } else {
        content.push(currentNode);
        currentNode = {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text }] },
              ],
            },
          ],
        };
        listType = 'bulletList';
      }
      // If the line starts with a task list delimiter (- [ ] or * [ ])
    } else if (line.startsWith('- [') || line.startsWith('* [')) {
      // Determine if the task is checked based on the presence of [x] or [X]
      const checked = line.includes('[x]') || line.includes('[X]');
      // Extract the task item text
      const text = line.slice(line.indexOf(']') + 2);
      // If the current list type is a task list, append the task item to the current node
      if (listType === 'taskList') {
        currentNode.content.push({
          type: 'taskItem',
          attrs: { checked },
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        });
        // Otherwise, push the current node to the content array and start a new task list node
      } else {
        content.push(currentNode);
        currentNode = {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text }] },
              ],
            },
          ],
        };
        listType = 'taskList';
      }
      // If the line starts with an image delimiter (![)
    } else if (line.startsWith('![')) {
      // Extract the alt text and image source URL
      const altText = line.slice(2, line.indexOf(']'));
      const src = line.slice(line.indexOf('(') + 1, line.indexOf(')'));
      // Push a new image node to the content array
      content.push({
        type: 'image',
        attrs: { src, alt: altText },
      });
      // If the line doesn't match any special formatting
    } else {
      // Treat the line as plain text and append it to the current node
      const text = line;
      currentNode.content.push({ type: 'text', text });
    }
  });

  // If there is any remaining content in the current node, push it to the content array
  if (currentNode.content.length > 0) {
    content.push(currentNode);
  }

  // Return the parsed content as a JSON string
  return JSON.stringify({ type: 'doc', content });
}

function processTiptapNode(node: TiptapNode, markdown: string): string {
  // Process the node based on its type
  switch (node.type) {
    case 'paragraph':
      // Process each child node of the paragraph
      node.content?.forEach((child: TiptapNode) => {
        if (child.type === 'text') {
          let text = child.text || '';
          // Apply marks to the text based on the mark type
          (child.marks || []).forEach((mark: TiptapMarks) => {
            switch (mark.type) {
              case 'bold':
                text = `**${text}**`;
                break;
              case 'italic':
                text = `*${text}*`;
                break;
              case 'code':
                text = `\`${text}\``;
                break;
              case 'strike':
                text = `~~${text}~~`;
                break;
              case 'link':
                text = `[${text}](${mark.attrs.href})`;
                break;
            }
          });
          markdown += text;
        } else if (child.type === 'hardBreak') {
          markdown += '\n';
        }
      });
      markdown += '\n\n';
      break;
    case 'hardBreak':
      markdown += '\n';
      break;
    case 'blockquote':
      // Process each child node of the blockquote
      node.content?.forEach((child: TiptapNode) => {
        markdown += '> ';
        markdown = processTiptapNode(child, markdown);
      });
      break;
    case 'orderedList':
      // Process each list item of the ordered list
      node.content?.forEach((listItem: TiptapNode, index: number) => {
        markdown += `${index + 1}. `;
        markdown = processTiptapNode(listItem, markdown);
      });
      markdown += '\n';
      break;
    case 'bulletList':
      // Process each list item of the bullet list
      node.content?.forEach((listItem: TiptapNode) => {
        markdown += '- ';
        markdown = processTiptapNode(listItem, markdown);
      });
      markdown += '\n';
      break;
    case 'codeBlock':
      markdown += '```\n';
      // Concatenate the text content of each child node
      markdown +=
        node.content?.map((child: TiptapNode) => child.text).join('') || '';
      markdown += '\n```\n\n';
      break;
    case 'image':
      markdown += `![${node.attrs?.alt || ''}](${node.attrs?.src || ''})\n\n`;
      break;
    case 'listItem':
      // Process each child node of the list item
      node.content?.forEach((child: TiptapNode) => {
        markdown = processTiptapNode(child, markdown);
      });
      markdown += '\n';
      break;
    case 'heading':
      const level = node.attrs?.level || 1;
      // Concatenate the text content of each child node
      const headingText = node.content
        ?.map((child: TiptapNode) => child.text || '')
        .join('');
      markdown += `${'#'.repeat(level)} ${headingText}\n\n`;
      break;
    case 'taskList':
      // Process each list item of the task list
      node.content?.forEach((listItem: TiptapNode) => {
        const checked = listItem.attrs?.checked ? '[x]' : '[ ]';
        // Concatenate the text content of each child node
        const itemText = listItem.content
          ?.map((child: TiptapNode) =>
            child.content
              ?.map((grandChild: TiptapNode) => grandChild.text || '')
              .join(''),
          )
          .join('');
        markdown += `- ${checked} ${itemText}\n`;
      });
      markdown += '\n';
      break;
  }
  return markdown;
}

export function convertTiptapJsonToMarkdownOld(tiptapJson: string): string {
  const parsedJson = JSON.parse(tiptapJson);
  let markdown = '';

  parsedJson.content.forEach((node: TiptapNode) => {
    markdown = processTiptapNode(node, markdown);
  });

  return markdown.trim();
}

export function convertHtmlToTiptapJson(html: string) {
  const tiptapJson = generateJSON(html, tiptapExtensions);
  return tiptapJson;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertTiptapJsonToHtml(tiptapJson: Record<string, any>) {
  return generateHTML(tiptapJson, tiptapExtensions);
}

export function convertMarkdownToTiptapJson(markdown: string) {
  // Both options are tokenizer-level: `gfm` is what turns ~~text~~ into <del>
  // and `breaks` is what turns a single newline into <br>. Passing them only
  // to `parser` — as this used to — leaves them inert, because by then the
  // markdown has already been tokenized with the defaults.
  const markedOptions = {
    gfm: true, // Enable GitHub Flavored Markdown
    breaks: true, // Render line breaks as <br>
  };
  const tokens = marked.lexer(markdown, markedOptions);
  const htmlText = marked.parser(tokens, markedOptions);

  return convertHtmlToTiptapJson(htmlText);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertTiptapJsonToMarkdown(tiptapJson: string) {
  try {
    const parsedTiptapJson = JSON.parse(tiptapJson);
    let finalJson = parsedTiptapJson;
    if (parsedTiptapJson.hasOwnProperty('json')) {
      finalJson = parsedTiptapJson.json;
    }
    const htmlText = convertTiptapJsonToHtml(finalJson);
    return buildTurndownService().turndown(htmlText);
  } catch (e) {
    return '';
  }
}
