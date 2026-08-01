import { Blockquote } from '@tiptap/extension-blockquote';
import { BulletList } from '@tiptap/extension-bullet-list';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { ListItem } from '@tiptap/extension-list-item';
import { OrderedList } from '@tiptap/extension-ordered-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { Text } from '@tiptap/extension-text';
import { Underline } from '@tiptap/extension-underline';

/**
 * The Tiptap extensions an email body is parsed with.
 *
 * Listed rather than taken from a shared default: this decides which HTML from
 * a stranger's email survives into an issue description. Anything not here is
 * dropped, which is the behaviour worth keeping — a `<script>` in a forwarded
 * newsletter has no extension and does not become content.
 */
export const TIPTAP_EXTENSIONS = [
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
];
