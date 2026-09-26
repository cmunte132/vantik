import { Injectable, NotFoundException } from '@nestjs/common';
import { Notification, updateNotificationBody } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

@Injectable()
export default class NotificationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Marks one of the caller's notifications read or snoozed.
   *
   * A notification is its recipient's alone. The id comes from the client, and
   * the route used to update whatever row it named: any signed-in user could
   * mark someone else's notification read, in any workspace, and was handed
   * back its contents. Someone else's is answered as missing, so an id can't be
   * probed.
   */
  async updateNotification(
    notificationId: string,
    userId: string,
    notificationData: updateNotificationBody,
  ): Promise<Notification> {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId, deleted: null },
      select: { id: true },
    });

    if (!notification) {
      throw new NotFoundException({
        message: `Notification ${notificationId} not found`,
      });
    }

    return await this.prisma.notification.update({
      where: { id: notificationId },
      data: notificationData,
    });
  }
}
