import { MailerService } from '@nestjs-modules/mailer';
import { PrismaService } from 'nestjs-prisma';

import { AuthService } from './auth.service';

describe('email sign-in delivery', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('returns an unavailable error instead of a successful login flow when SMTP fails', async () => {
    process.env = { ...originalEnv, NODE_ENV: 'test', SMTP_HOST: 'smtp.example.invalid' };
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const prisma = {
      emailVerification: { create: async () => ({}) },
    } as unknown as PrismaService;
    const mailer = {
      sendMail: async () => { throw new Error('SMTP connection failed'); },
    } as unknown as MailerService;
    const service = new AuthService(prisma, mailer);

    await expect(service.createEmailCode('person@example.invalid')).rejects.toMatchObject({ status: 503 });
  });
});
