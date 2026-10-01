import { RiFlashlightLine, RiStackLine } from '@remixicon/react';
import {
  RiDiscordFill,
  RiGitBranchLine,
  RiGitRepositoryLine,
  RiGithubFill,
  RiMailFill,
} from '@remixicon/react';

export const ICON_MAPPING = {
  email: RiMailFill,
  discord: RiDiscordFill,
  github: RiGithubFill,
  'local-repo': RiGitRepositoryLine,
  'git-remote': RiGitBranchLine,

  // Defaults
  integration: RiStackLine,
  bot: RiFlashlightLine,
};

export type IconType = keyof typeof ICON_MAPPING;

export function getIcon(icon: IconType) {
  if (icon in ICON_MAPPING) {
    return ICON_MAPPING[icon];
  }

  return ICON_MAPPING['integration'];
}

export function getBotIcon(icon: IconType) {
  if (icon in ICON_MAPPING) {
    return ICON_MAPPING[icon];
  }

  return ICON_MAPPING['bot'];
}
