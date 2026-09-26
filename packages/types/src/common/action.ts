/**
 * What happened to a record, or that a vendor's webhook arrived.
 *
 * Named for the Actions it was written for, which are gone. Notifications and
 * connected integrations are what read it now.
 */
export enum ActionTypesEnum {
  ON_CREATE = 'on_create',
  ON_UPDATE = 'on_update',
  ON_DELETE = 'on_delete',
  SOURCE_WEBHOOK = 'source_webhook',
}

export interface ActionEventPayload {
  event: ActionTypesEnum;
  [x: string]: any;
}
