import { RoleEnum, UserTypeEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

interface BotDefinition {
  slug: string;
  name: string;
  icon: string;
}

/**
 * The member a connected integration writes as, made on its first event.
 *
 * A plugin has no session, so whatever it writes — the issue an email became,
 * the comment mirrored in from GitHub — needs an author. That author is one
 * BOT member per integration per workspace, and the role is load-bearing: the
 * GitHub sync ignores a change made by a BOT, which is what stops a mirrored
 * comment from being mirrored straight back.
 *
 * The address is the one a deployed Action used for the same slug, so a
 * workspace that ran the GitHub Action keeps one author across the move rather
 * than gaining a second "GitHub" beside the first. The image is the
 * definition's icon key, which is what the webapp draws a bot with.
 */
export async function ensureIntegrationBot(
  prisma: PrismaService,
  workspaceId: string,
  definition: BotDefinition,
): Promise<string> {
  const email = `${definition.slug}_${workspaceId}@vantik.dev`;

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      username: definition.slug,
      fullname: definition.name,
      image: definition.icon,
      type: UserTypeEnum.System,
    },
    update: {},
    select: { id: true },
  });

  const member = await prisma.usersOnWorkspaces.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    select: { role: true },
  });

  if (member?.role === RoleEnum.BOT) {
    return user.id;
  }

  // Every team, because the bot writes wherever a mapping points. A team made
  // later is joined by the bot when it is created: `createTeam` adds BOT
  // members to it.
  const teamIds = (
    await prisma.team.findMany({
      where: { workspaceId, deleted: null },
      select: { id: true },
    })
  ).map((team) => team.id);

  await prisma.usersOnWorkspaces.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    create: { userId: user.id, workspaceId, role: RoleEnum.BOT, teamIds },
    update: { role: RoleEnum.BOT },
  });

  return user.id;
}
