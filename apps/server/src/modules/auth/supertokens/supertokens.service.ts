import { Injectable } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import supertokens, { deleteUser } from 'supertokens-node';

import { UsersService } from 'modules/users/users.service';

import { recipeList } from './supertokens.config';

@Injectable()
export class SupertokensService {
  constructor(
    private usersService: UsersService,
    private mailerService: MailerService,
  ) {
    supertokens.init({
      appInfo: {
        appName: 'Vantik',
        apiDomain: process.env.BACKEND_HOST,
        websiteDomain: process.env.FRONTEND_HOST.split(',')[0] || '',
        // Must match the path the *browser* uses, not the path this server
        // receives. SuperTokens scopes the refresh token cookie to
        // `apiBasePath + /session/refresh`, and that path is enforced by the
        // browser. The webapp calls auth routes at /api/auth/*, so anything
        // else here means the refresh cookie is never sent and sessions die
        // when the access token expires. The Next proxy forwards /api/auth/*
        // through unstripped to keep both sides in agreement.
        apiBasePath: '/api/auth',
        websiteBasePath: '/auth',
      },
      supertokens: {
        connectionURI: process.env.SUPERTOKEN_CONNECTION_URI,
      },
      recipeList: recipeList(this.usersService, this.mailerService),
    });
  }

  async deleteUserForId(userId: string) {
    await deleteUser(userId);
  }
}
