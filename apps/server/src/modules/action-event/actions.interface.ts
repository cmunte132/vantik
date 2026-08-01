/**
 * The queue an action runs on.
 *
 * Replaces `tasks.trigger('action-run', …)`, which sent the work to trigger.dev
 * — a service that is optional, is not in `docker-compose.yaml`, and has never
 * run in this deployment. Redis is already required by the stack, and the
 * README states the rule: no necessary work may depend on an optional service.
 * See ENG-89.
 */
export const ACTIONS_QUEUE = 'actions';

/** Run one action for one event. */
export const RUN_ACTION_JOB = 'runAction';

/**
 * What the processor is given.
 *
 * The whole payload is plain data. Nothing here is a live object or a client,
 * because the point of moving off trigger.dev is not the queue — it is that a
 * dispatch carrying only messages can be consumed anywhere later: in this
 * process, in a forked worker, or in a sandbox, chosen per plugin rather than
 * per codebase.
 */
export interface RunActionJob {
  /** The integration this action belongs to, and the directory its code lives in. */
  slug: string;
  workspaceId: string;
  actionId: string;
  /** `ActionTypesEnum` — ON_CREATE, ON_UPDATE, SOURCE_WEBHOOK, GET_INPUTS. */
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
}
