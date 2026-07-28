import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { SignedURLBody } from '@vantikhq/types';
import { Request, Response } from 'express';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import {
  Session as SessionDecorator,
  UserId,
  Workspace,
} from 'modules/auth/session.decorator';

import {
  AttachmentRequestParams,
  AttachmentBody,
} from './attachments.interface';
import { AttachmentService } from './attachments.service';

@Controller({
  version: '1',
  path: 'attachment',
})
export class AttachmentController {
  constructor(private readonly attachementService: AttachmentService) {}

  @Post('upload')
  @UseInterceptors(FilesInterceptor('files'))
  @UseGuards(AuthGuard)
  async uploadFiles(
    @SessionDecorator() session: SessionContainer,
    @Workspace() workspaceId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() attachmentBody: AttachmentBody,
  ) {
    const userId = getAppUserId(session);

    const sourceMetadata = attachmentBody.sourceMetadata
      ? JSON.parse(attachmentBody.sourceMetadata)
      : null;

    return await this.attachementService.uploadAttachment(
      files,
      userId,
      workspaceId,
      sourceMetadata,
    );
  }

  @Post('upload/action')
  @UseInterceptors(FilesInterceptor('files'))
  @UseGuards(AuthGuard)
  async uploadActionFile(@UploadedFiles() files: Express.Multer.File[]) {
    return await this.attachementService.uploadActionFile(files[0]);
  }

  @Post('get-signed-url')
  @UseGuards(AuthGuard)
  async getUploadSignedUrl(
    @Body() attachmentBody: SignedURLBody,
    @Workspace() workspaceId: string,
    @UserId() userId: string,
  ) {
    return await this.attachementService.uploadGenerateSignedURL(
      attachmentBody,
      userId,
      workspaceId,
    );
  }

  @Get('get-signed-url/:attachmentId')
  @UseGuards(AuthGuard)
  async getSignedUrlForFile(
    @Workspace() workspaceId: string,
    @Param() attachementRequestParams: AttachmentRequestParams,
  ) {
    try {
      return await this.attachementService.getFileFromStorageSignedUrl(
        attachementRequestParams,
        workspaceId,
      );
    } catch (error) {
      return undefined;
    }
  }

  @Get('actions/:attachmentId')
  async getFileForAction(
    @Param() { attachmentId }: { attachmentId: string },
    @Res() res: Response,
  ) {
    try {
      const buffer =
        await this.attachementService.getActionFileContents(attachmentId);

      // Set content disposition header with the original filename
      res.set({
        'Content-Type': 'application/javascript',
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, immutable, max-age=31536000', // Cache for 1 year (effectively infinite)
      });

      res.send(buffer);
    } catch (error) {
      res.status(404).send('File not found');
    }
  }

  /**
   * Serves a signed URL that the local backend made. The token is the whole
   * authority here, so there is no session guard: the signature proves the
   * server made the URL, and the claims inside say which file and until when.
   */
  @Get('local/:token')
  async readLocalSignedFile(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const { buffer, contentType, disposition } =
      await this.attachementService.readSignedLocalFile(token);

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': disposition,
      // The token expires, so a shared cache must not keep the answer.
      'Cache-Control': 'private, max-age=0, no-store',
    });

    res.send(buffer);
  }

  @Put('local/:token')
  async writeLocalSignedFile(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.attachementService.writeSignedLocalFile(
      token,
      req.body as Buffer,
    );

    res.status(200).send();
  }

  @Get(':workspaceId/:attachmentId')
  @UseGuards(AuthGuard)
  async getFileForWorkspace(
    @Param() attachementRequestParams: AttachmentRequestParams,
    @Res() res: Response,
  ) {
    try {
      const { buffer, contentType } =
        await this.attachementService.getFileFromStorage(
          attachementRequestParams,
          attachementRequestParams.workspaceId,
        );

      // Set content disposition header with the original filename
      res.set({
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, immutable, max-age=31536000', // Cache for 1 year (effectively infinite)
      });

      res.send(buffer);
    } catch (error) {
      res.status(404).send('File not found');
    }
  }

  @Get(':attachmentId')
  @UseGuards(AuthGuard)
  async getFile(
    @Workspace() workspaceId: string,
    @Param() attachementRequestParams: AttachmentRequestParams,
    @Res() res: Response,
  ) {
    try {
      const { buffer, contentType } =
        await this.attachementService.getFileFromStorage(
          attachementRequestParams,
          workspaceId,
        );

      // Set content disposition header with the original filename
      res.set({
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, immutable, max-age=31536000', // Cache for 1 year (effectively infinite)
      });

      res.send(buffer);
    } catch (error) {
      res.status(404).send('File not found');
    }
  }

  @Delete(':workspaceId/:attachmentId')
  @UseGuards(AuthGuard)
  async deleteAttachment(
    @Workspace() workspaceId: string,
    @Param() attachementRequestParams: AttachmentRequestParams,
  ) {
    await this.attachementService.deleteAttachment(
      attachementRequestParams,
      workspaceId,
    );
    return { message: 'Attachment deleted successfully' };
  }
}
