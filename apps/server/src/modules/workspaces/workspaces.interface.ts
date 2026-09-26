import { RoleEnum, WorkspaceStatusEnum } from '@vantikhq/types';
import {
  filterPrompt,
  issueDescriptionPrompt,
  issueLabelPrompt,
  issueSummarizePrompt,
  issueTitlePrompt,
  moduleClassifierPrompt,
  subIssuesPrompt,
  viewNameDescriptionPrompt,
} from '@vantikhq/types';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateInitialResourcesDto {
  @IsString()
  workspaceName: string;

  @IsString()
  fullname: string;

  @IsString()
  teamName: string;

  @IsString()
  teamIdentifier: string;
}

export class UpdateWorkspaceInput {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  icon: string;
}

export class UserBody {
  @IsString()
  userId: string;
}

export interface UserWorkspaceOtherData {
  teamIds?: string[];
  status?: WorkspaceStatusEnum;
  joinedAt?: string;
  role?: RoleEnum;
}

export class InviteUsersBody {
  /** Comma separated. */
  @IsString()
  emailIds: string;

  @IsArray()
  @IsString({ each: true })
  teamIds: string[];

  // A person joins as one or the other; bots and agents are made elsewhere.
  @IsIn([RoleEnum.ADMIN, RoleEnum.USER])
  role: RoleEnum;
}

export class InviteActionBody {
  @IsBoolean()
  accept: boolean;

  @IsString()
  inviteId: string;
}

export const labelSeedData = [
  { name: 'Bug', color: '#ed5b4a' },
  { name: 'Feature', color: '#00aa91' },
  { name: 'Design', color: '#00a5b5' },
  { name: 'Documentation', color: '#009dde' },
  { name: 'Frontend', color: '#a074f3' },
  { name: 'Backend', color: '#d55eba' },
];

export const promptsSeedData = [
  {
    name: 'IssueTitle',
    prompt: issueTitlePrompt,
    model: 'fast',
  },
  {
    name: 'IssueLabels',
    prompt: issueLabelPrompt,
    model: 'fast',
  },
  {
    name: 'IssueSummary',
    prompt: issueSummarizePrompt,
    model: 'fast',
  },
  {
    name: 'Filter',
    prompt: filterPrompt,
    model: 'smart',
  },
  {
    name: 'SubIssues',
    prompt: subIssuesPrompt,
    model: 'smart',
  },
  {
    name: 'ViewNameDescription',
    prompt: viewNameDescriptionPrompt,
    model: 'fast',
  },
  {
    name: 'IssueDescription',
    prompt: issueDescriptionPrompt,
    model: 'smart',
  },
  {
    // Names the modules an issue would change. `fast` on purpose: the answer
    // is a suggestion a person accepts or dismisses, never a write to the
    // issue, so the cost of a wrong one is a chip nobody clicks.
    name: 'ModuleClassifier',
    prompt: moduleClassifierPrompt,
    model: 'fast',
  },
];
