/* eslint-disable @typescript-eslint/ban-types */

import type { AjaxBaseConfig, XHRErrorResponse } from './ajaxBase';

import { triggerError, triggerSuccess } from './ajaxEvents';
import { isServer } from '../common';

/**
 * @internal
 * `onSuccess` handler parameters.
 */
interface OnSuccessParams<T, E> {
  /** Ajax Configuration Object */
  config: AjaxBaseConfig<unknown, T, E>;
  /** Response Data */
  data: T | string;
  /** Response Headers */
  headers: Record<string, string>;
  /** Resolver Function */
  resolve: Function;
}

/**
 * @internal
 * Handles Success of a XHR with Promise Fulfillment.
 * @param param - `onSuccess` handler parameters.
 */
export function onSuccess<T, E>({
  config,
  data: rawData,
  headers,
  resolve,
}: OnSuccessParams<T, E>) {
  const { disableEvents, onSuccess } = config;

  if (onSuccess) {
    onSuccess(rawData as string | T, headers);
  }

  resolve(rawData);

  if (!isServer() && !disableEvents) {
    // Response headers reach the global listeners too: the build stamp rides on
    // every response, so version drift is detected on traffic the app already
    // makes rather than on a poll of its own.
    triggerSuccess(rawData, config, headers);
  }
}

/**
 * @internal
 * `onError` handler parameters.
 */
interface OnErrorParams<T, E> {
  /** Ajax Configuration Object */
  config: AjaxBaseConfig<unknown, T, E>;
  /** Response Error */
  error: XHRErrorResponse<E>;
  /** Response Headers */
  headers?: Record<string, string>;
  /** Rejection Function */
  reject: Function;
}

/**
 * @internal
 * Handles Failure of a XHR with Promise Rejection.
 * @param param - `onError` handler parameters.
 */
export function onError<T, E>({
  config,
  error: { errors, ...rawError },
  headers,
  reject,
}: OnErrorParams<T, E>) {
  const { disableEvents, onError } = config;

  /** Transform Payload Keys into camelCase */
  const error = {
    ...rawError,
    ...(errors ? { errors } : {}),
  };

  if (onError) {
    onError(error);
  }

  reject(error);

  if (!isServer() && !disableEvents) {
    // The failing request is the most valuable place to read the build stamp:
    // if a client broke because its build was replaced, this is where it finds
    // out.
    triggerError(error, config, headers);
  }
}
