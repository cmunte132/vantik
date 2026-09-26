import { smtpConfigured, smtpFrom, smtpTransportOptions } from './smtp';

describe('smtpTransportOptions', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
  });

  it('upgrades with STARTTLS unless implicit TLS is asked for', () => {
    process.env = { ...env, SMTP_HOST: 'mail', SMTP_PORT: '587' };

    expect(smtpTransportOptions()).toMatchObject({
      host: 'mail',
      port: 587,
      secure: false,
    });

    process.env.SMTP_USE_SLS = 'true';
    expect(smtpTransportOptions().secure).toBe(true);
  });

  it('checks certificates, and signs in only when a user is set', () => {
    process.env = { ...env, SMTP_HOST: 'mail', SMTP_USER: '' };
    const options = smtpTransportOptions();

    expect(options).not.toHaveProperty('tls');
    expect(options.auth).toBeUndefined();

    process.env.SMTP_USER = 'vantik';
    process.env.SMTP_PASSWORD = 'secret';
    expect(smtpTransportOptions().auth).toEqual({
      user: 'vantik',
      pass: 'secret',
    });
  });

  it('names the configured sender, and knows when there is no server', () => {
    process.env = {
      ...env,
      SMTP_HOST: '',
      SMTP_DEFAULT_FROM: 'Ops <ops@x.io>',
    };

    expect(smtpConfigured()).toBe(false);
    expect(smtpFrom()).toBe('Ops <ops@x.io>');
  });
});
