import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { isSessionValid } from 'common/authentication';

import { AuthService } from 'modules/auth/auth.service';
import { UsersService } from 'modules/users/users.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private moduleRef: ModuleRef,
    // AuthModule is global, so the injector finds AuthService from every
    // module. A strict ModuleRef lookup does not search global modules.
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (request.session) {
      return true;
    }
    const usersService = await this.moduleRef.resolve(UsersService, undefined, {
      strict: false,
    });

    return isSessionValid(request, usersService, this.authService);
  }
}
