import type { AjaxBaseConfig } from './ajaxBase';

import { ajax } from './ajax';

/** Ajax Configuration for DELETE request */
export type AjaxDeleteConfig<TResponseData, TError = unknown> = Omit<
  AjaxBaseConfig<void, TResponseData, TError>,
  'method' | 'upload' | 'data'
>;

/**
 * Sends DELETE request to Server.
 * @param config - Ajax Configuration for DELETE request.
 * @returns Extended Promise with XHR request.
 */
export const ajaxDelete = <TResponseData, TError = unknown>(
  config: AjaxDeleteConfig<TResponseData, TError>,
) => {
  return ajax<void, TResponseData, TError>({ ...config, method: 'delete' });
};

/** Ajax Configuration for GET request */
export type AjaxGetConfig<TResponseData, TError = unknown> = Omit<
  AjaxBaseConfig<void, TResponseData, TError>,
  'method' | 'data' | 'upload'
>;

/**
 * Sends GET request to Server.
 * @param config - Ajax Configuration for GET request.
 * @returns Extended Promise with XHR request.
 */
export const ajaxGet = <TResponseData, TError = unknown>(
  config: AjaxGetConfig<TResponseData, TError>,
) => {
  return ajax<void, TResponseData, TError>({
    ...config,
    method: 'get',
  });
};

/** Ajax Configuration for POST request */
export type AjaxPostConfig<
  TRequestData,
  TResponseData,
  TError = unknown,
> = Omit<
  AjaxBaseConfig<TRequestData, TResponseData, TError>,
  'method' | 'query' | 'upload'
>;

/**
 * Sends POST request to Server.
 * @param config - Ajax Configuration for POST request.
 * @returns Extended Promise with XHR request.
 */
export const ajaxPost = <TRequestData, TResponseData, TError = unknown>(
  config: AjaxPostConfig<TRequestData, TResponseData, TError>,
) => {
  return ajax<TRequestData, TResponseData, TError>({
    ...config,
    method: 'post',
  });
};

/** Ajax Configuration for PUT request */
export type AjaxPutConfig<TRequestData, TResponseData, TError = unknown> = Omit<
  AjaxBaseConfig<TRequestData, TResponseData, TError>,
  'method' | 'query' | 'upload'
>;

/**
 * Sends PUT request to Server.
 * @param config - Ajax Configuration for PUT request.
 * @returns Extended Promise with XHR request.
 */
export const ajaxPut = <TRequestData, TResponseData, TError = unknown>(
  config: AjaxPutConfig<TRequestData, TResponseData, TError>,
) => {
  return ajax<TRequestData, TResponseData, TError>({
    ...config,
    method: 'put',
  });
};
