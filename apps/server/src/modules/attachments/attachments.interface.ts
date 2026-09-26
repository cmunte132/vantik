import { IsString } from 'class-validator';

/** A file in the caller's workspace, the way the editor links one. */
export class AttachmentIdParams {
  @IsString()
  attachmentId: string;
}

/**
 * A file in the workspace the URL names, the way an integration's upload
 * links one. The route that takes these had to have both; the one above
 * required a `workspaceId` its path never carries, so every request to it
 * failed validation and no image in an issue or comment ever loaded.
 */
export class AttachmentRequestParams extends AttachmentIdParams {
  @IsString()
  workspaceId: string;
}
