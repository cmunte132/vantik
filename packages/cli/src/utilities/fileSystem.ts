import fsSync from 'fs';

export function readJSONFileSync(path: string) {
  const fileContents = fsSync.readFileSync(path, 'utf8');

  return JSON.parse(fileContents);
}
