import { Injectable } from '@nestjs/common';
import { Notification, updateNotificationBody } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

@Injectable()
export default class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async updateNotification(
    notificationId: string,
    notificationData: updateNotificationBody,
  ): Promise<Notification> {
    return await this.prisma.notification.update({
      where: { id: notificationId },
      data: notificationData,
    });
  }
}
