import { types } from 'mobx-state-tree';

export const IssueSuggestion = types.model('Issue', {
  id: types.string,
  createdAt: types.string,
  updatedAt: types.string,
  issueId: types.string,
  suggestedLabelIds: types.array(types.string),
  suggestedAssigneeId: types.union(types.string, types.null),
  // The modules the classifier proposes. Optional because a row written before
  // the classifier existed carries no such column in the payload, and MST
  // rejects the whole snapshot over one missing field.
  suggestedModuleIds: types.optional(types.array(types.string), []),
});

export const IssueSuggestionMap = types.map(IssueSuggestion);
