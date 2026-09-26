import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SignedURLBody } from '@vantikhq/types';
import { Request, Response } from 'express';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import {
  AttachmentIdParams,
  AttachmentRequestParams,
} from './attachments.interface';
import { AttachmentService } from './attachments.service';

@Controller({
  version: '1',
  path: 'attachment',
})
export class AttachmentController {
  constructor(
    private readonly attachementService: AttachmentService,
    private readonly prisma: PrismaService,
  ) {}

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
    @UserId() userId: string,
    @Workspace() sessionWorkspaceId: string,
    @Res() res: Response,
  ) {
    try {
      // The path names the workspace, so it has to be one the caller belongs
      // to: without this, any signed-in user could read any workspace's files
      // from their URLs. A refusal reads as a missing file, like any other.
      const workspaceId = await resolveWorkspaceId(
        this.prisma,
        userId,
        sessionWorkspaceId,
        attachementRequestParams.workspaceId,
      );
      const { buffer, contentType } =
        await this.attachementService.getFileFromStorage(
          attachementRequestParams,
          workspaceId,
        );

      // Set content disposition header with the original filename
      res.set({
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        // Private: only a member may read it, so no shared cache may keep it.
        'Cache-Control': 'private, immutable, max-age=31536000',
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
    @Param() attachementRequestParams: AttachmentIdParams,
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
        // Private: only a member may read it, so no shared cache may keep it.
        'Cache-Control': 'private, immutable, max-age=31536000',
      });

      res.send(buffer);
    } catch (error) {
      res.status(404).send('File not found');
    }
  }
}
