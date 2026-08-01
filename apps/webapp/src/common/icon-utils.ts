import { RiFlashlightLine, RiStackLine } from '@remixicon/react';
import {
  RiDiscordFill,
  RiGitRepositoryLine,
  RiGithubFill,
  RiMailFill,
} from '@remixicon/react';
import { Whatsapp } from '@vantikhq/ui/icons';

export const ICON_MAPPING = {
  email: RiMailFill,
  discord: RiDiscordFill,
  github: RiGithubFill,
  whatsapp: Whatsapp,
  'local-repo': RiGitRepositoryLine,

  // Default icon
  integration: RiStackLine,
  action: RiFlashlightLine,
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

  return ICON_MAPPING['action'];
}
