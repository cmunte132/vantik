export { VantikClient } from './client';
export type { VantikClientConfig } from './client';
export { Directory, isUuid, parseIssueKey } from './directory';
export { VantikAgent } from './agent';
export type {
  CloseTaskInput,
  CreateProjectInput,
  CreateTaskInput,
  ListTasksInput,
  SearchTasksInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from './agent';
export {
  VantikAmbiguousError,
  VantikApiError,
  VantikAuthError,
  VantikError,
  VantikNotFoundError,
} from './errors';
export * from './types';
export * from './knowledge';
