import { CollectionFieldSchema } from 'typesense/lib/Typesense/Collection';
import { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections';

export const issueSchema: CollectionCreateSchema = {
  name: 'issues',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'teamId', type: 'string' },
    { name: 'number', type: 'int32' },
    { name: 'numberString', type: 'string' },
    { name: 'issueNumber', type: 'string' },
    { name: 'title', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'descriptionString', type: 'string' },
    { name: 'stateId', type: 'string' },
    // Workflow category of the current state (COMPLETED, STARTED, …), faceted
    // so a search can be restricted to resolved work.
    { name: 'stateCategory', type: 'string', facet: true },
    // Concatenated text of every non-deleted comment — fixes are described in
    // comments, so they have to be searchable and part of the embedding.
    { name: 'commentsText', type: 'string' },
    // Best guess at the comment explaining how the issue was resolved.
    { name: 'resolutionText', type: 'string' },
    { name: 'workspaceId', type: 'string' },
    { name: 'assigneeId', type: 'string' },
  ],
  default_sorting_field: 'number',
};

export const cohereEmbedding: CollectionFieldSchema = {
  name: 'embeddings',
  type: 'float[]',
  num_dim: 1024,
};

export const typesenseEmbedding: CollectionFieldSchema = {
  name: 'embeddings',
  type: 'float[]',
  embed: {
    from: ['issueNumber', 'title', 'description', 'commentsText'],
    model_config: {
      model_name: 'ts/all-MiniLM-L12-v2',
    },
  },
};

export interface IssueSearchHit {
  id: string;
  title: string;
  description: string;
  descriptionString: string;
  stateId: string;
  stateCategory: string;
  resolutionSnippet: string;
  teamId: string;
  number: number;
  issueNumber: string;
  workspaceId: string;
  assigneeId: string;
  distance?: number;
  relevanceScore?: number;
}

/**
 * Fields the running code depends on; a collection missing any is stale.
 * `id` is excluded: typesense treats it as a reserved document key and never
 * reports it back in a collection's field list, so checking for it would mark
 * every collection stale and rebuild the index on every boot.
 */
export const requiredIssueFields = issueSchema.fields
  .map((field) => field.name)
  .filter((name) => name !== 'id');

/** How much comment text is indexed per issue (newest comments kept). */
export const MAX_COMMENTS_TEXT_LENGTH = 20_000;

/** Length of the resolution excerpt returned with each search hit. */
export const RESOLUTION_SNIPPET_LENGTH = 500;
