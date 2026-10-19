import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localSourceKey, remoteSourceKey } from './mirror-source';

describe('localSourceKey', () => {
  it('gives one key to a directory and to a link to it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mirror-source-')));

    try {
      mkdirSync(join(root, 'app'));
      symlinkSync(join(root, 'app'), join(root, 'link'));

      expect(await localSourceKey(join(root, 'link'))).toBe(
        await localSourceKey(join(root, 'app/')),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('remoteSourceKey', () => {
  it('ignores case, scheme, credentials, .git and a trailing slash', () => {
    const key = remoteSourceKey('https://git.example/owner/project');

    expect(remoteSourceKey('HTTPS://Git.Example/Owner/Project.git/')).toBe(key);
    expect(
      remoteSourceKey('http://user:secret@git.example/owner/project'),
    ).toBe(key);
    expect(remoteSourceKey('https://git.example/owner/other')).not.toBe(key);
  });
});
