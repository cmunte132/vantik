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
    model: 'default',
  },
  {
    name: 'IssueLabels',
    prompt: issueLabelPrompt,
    model: 'decisions',
  },
  {
    name: 'IssueSummary',
    prompt: issueSummarizePrompt,
    model: 'default',
  },
  {
    name: 'Filter',
    prompt: filterPrompt,
    model: 'default',
  },
  {
    name: 'SubIssues',
    prompt: subIssuesPrompt,
    model: 'default',
  },
  {
    name: 'ViewNameDescription',
    prompt: viewNameDescriptionPrompt,
    model: 'default',
  },
  {
    name: 'IssueDescription',
    prompt: issueDescriptionPrompt,
    model: 'default',
  },
  {
    // Names the modules an issue would change. A suggestion a person accepts
    // or dismisses, so it is a decision, like the labels.
    name: 'ModuleClassifier',
    prompt: moduleClassifierPrompt,
    model: 'decisions',
  },
];
