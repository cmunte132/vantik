import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';

import { AuthSessionContext } from 'modules/auth/auth.interface';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor() {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const session = request.session as AuthSessionContext;
    const role = session?.getAccessTokenPayload?.()?.role;

    return role === RoleEnum.ADMIN;
  }
}
