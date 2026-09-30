import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { AuthGuard } from './auth.guard';
import { AuthService, SESSION_COOKIE_NAME } from './auth.service';
import { UserId } from './session.decorator';

interface SigninCodeDto {
  email: string;
}

interface ConsumeCodeDto {
  preAuthSessionId: string;
  userInputCode?: string;
  deviceId?: string;
}

interface ConsumeLinkDto {
  preAuthSessionId: string;
  linkCode?: string;
}

interface PasskeyRegistrationDto {
  challenge: string;
  response: unknown;
  email?: string;
}

interface PasskeyAuthenticationDto {
  challenge: string;
  response: unknown;
}

@Controller({
  version: '1',
  path: 'auth',
})
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Checks whether the current request carries a valid session.
   */
  @Get('session')
  async getSession(
    @Req() req: Request,
  ): Promise<{ authenticated: boolean; user?: { id: string; email: string } }> {
    const cookie = req.cookies?.[SESSION_COOKIE_NAME];
    if (!cookie) {
      return { authenticated: false };
    }
    const context = await this.authService.resolveRequestSession(req, cookie);
    if (!context) {
      return { authenticated: false };
    }
    const userId = context.getUserId();
    return { authenticated: true, user: { id: userId, email: '' } };
  }

  /**
   * Signs out the current session and clears the cookie.
   */
  @Post('signout')
  @HttpCode(HttpStatus.OK)
  async signOut(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'OK' }> {
    const cookie = req.cookies?.[SESSION_COOKIE_NAME];
    if (cookie) {
      await this.authService.revokeSession(cookie);
    }
    this.authService.clearSessionCookie(res);
    return { status: 'OK' };
  }

  /**
   * Sends a login code and a magic link to the email address.
   */
  @Post('signinup/code')
  @HttpCode(HttpStatus.OK)
  async signinupCode(
    @Body() body: SigninCodeDto,
  ): Promise<{
    status: 'OK';
    deviceId: string;
    preAuthSessionId: string;
    flowType: 'USER_INPUT_CODE_AND_MAGIC_LINK';
  }> {
    if (!body?.email) {
      throw new BadRequestException('Email is required');
    }
    const result = await this.authService.createEmailCode(body.email);
    return {
      status: 'OK',
      deviceId: result.deviceId,
      preAuthSessionId: result.preAuthSessionId,
      flowType: 'USER_INPUT_CODE_AND_MAGIC_LINK',
    };
  }

  /**
   * Signs in with the code that the person types.
   */
  @Post('signinup/code/consume')
  @HttpCode(HttpStatus.OK)
  async consumeCode(
    @Body() body: ConsumeCodeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.preAuthSessionId || !body?.userInputCode) {
      throw new BadRequestException('preAuthSessionId and userInputCode are required');
    }
    return await this.authService.consumeEmailCode(
      body.preAuthSessionId,
      body.userInputCode,
      res,
    );
  }

  /**
   * Consumes magic link token.
   */
  @Post('signinup/link/consume')
  @HttpCode(HttpStatus.OK)
  async consumeLink(
    @Body() body: ConsumeLinkDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.preAuthSessionId || !body?.linkCode) {
      throw new BadRequestException('preAuthSessionId and linkCode are required');
    }
    return await this.authService.consumeMagicLink(
      body.preAuthSessionId,
      body.linkCode,
      res,
    );
  }

  // --- WebAuthn / Passkeys ---

  /**
   * Check whether WebAuthn is supported / enabled on server.
   */
  @Get('webauthn/supported')
  getSupported() {
    return {
      status: 'OK',
      passkeySignupEnabled: this.authService.isPasskeySignupEnabled(),
    };
  }

  /**
   * The server creates options for a new account or the authenticated user.
   */
  @Post('webauthn/register/options')
  @HttpCode(HttpStatus.OK)
  async registerOptions(
    @Body() body: { email?: string },
    @Req() req: Request,
  ) {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    const context = token
      ? await this.authService.resolveRequestSession(req, token)
      : null;
    const userId = context?.getUserId();

    if (!userId) {
      if (!this.authService.isPasskeySignupEnabled()) {
        return {
          status: 'SIGN_UP_NOT_ALLOWED',
          reason:
            'Creating an account with a passkey is disabled on this instance. Sign in with your email first, then add a passkey.',
        };
      }
      if (!body?.email) {
        throw new BadRequestException('Email is required to create a passkey account');
      }
    }

    const { options, user } = await this.authService.generatePasskeyRegistrationOptions({
      userId,
      email: body?.email,
    });
    return {
      status: 'OK',
      options,
      user,
    };
  }

  /**
   * The server verifies the response and saves the credential.
   */
  @Post('webauthn/register/verify')
  @HttpCode(HttpStatus.OK)
  async registerVerify(
    @Body() body: PasskeyRegistrationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.challenge || !body?.response) {
      throw new BadRequestException('Challenge and response are required');
    }

    const token = req.cookies?.[SESSION_COOKIE_NAME];
    const context = token
      ? await this.authService.resolveRequestSession(req, token)
      : null;
    const userId = context?.getUserId();

    if (!userId) {
      if (!this.authService.isPasskeySignupEnabled()) {
        return {
          status: 'SIGN_UP_NOT_ALLOWED',
          reason:
            'Creating an account with a passkey is disabled on this instance. Sign in with your email first, then add a passkey.',
        };
      }
      if (!body.email) {
        throw new BadRequestException('Email is required');
      }
    }

    const verification = await this.authService.verifyPasskeyRegistration(
      { userId, email: body.email },
      body.challenge,
      body.response as never,
      res,
    );

    if (verification.verified) {
      return { status: 'OK' };
    }
    return { status: 'FAILED_TO_REGISTER_USER' };
  }

  /**
   * Generate passkey sign-in options.
   */
  @Post('webauthn/signin/options')
  @HttpCode(HttpStatus.OK)
  async signinOptions(@Body() body?: { email?: string }) {
    const options = await this.authService.generatePasskeyAuthenticationOptions(body?.email);
    return {
      status: 'OK',
      options,
    };
  }

  /**
   * Verify passkey sign-in.
   */
  @Post('webauthn/signin/verify')
  @HttpCode(HttpStatus.OK)
  async signinVerify(
    @Body() body: PasskeyAuthenticationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body?.challenge || !body?.response) {
      throw new BadRequestException('Challenge and response are required');
    }
    const result = await this.authService.verifyPasskeyAuthentication(
      body.challenge,
      body.response as never,
      res,
    );
    if (result.verified) {
      return { status: 'OK', user: result.user };
    }
    return { status: 'FAILED_TO_AUTHENTICATE_USER' };
  }

  /**
   * List passkeys for the signed-in user.
   */
  @Get('webauthn/credentials')
  @UseGuards(AuthGuard)
  async listCredentials(@UserId() userId: string) {
    const credentials = await this.authService.listPasskeys(userId);
    return {
      status: 'OK',
      credentials,
    };
  }

  /**
   * Remove a passkey for the signed-in user.
   */
  @Delete('webauthn/credentials/:credentialId')
  @UseGuards(AuthGuard)
  async removeCredential(
    @UserId() userId: string,
    @Param('credentialId') credentialId: string,
  ) {
    const ok = await this.authService.removePasskey(userId, credentialId);
    if (!ok) {
      throw new NotFoundException('Passkey not found');
    }
    return { status: 'OK' };
  }
}
