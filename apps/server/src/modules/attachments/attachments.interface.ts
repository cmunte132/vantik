import { IsString } from 'class-validator';

export class AttachmentRequestParams {
  @IsString()
  attachmentId: string;

  @IsString()
  workspaceId: string;
}
