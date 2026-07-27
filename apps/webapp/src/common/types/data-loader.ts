const enum Action {
  I = 'I',
  U = 'U',
  D = 'D',
}

export interface SyncActionRecord {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;

  modelName: string;
  modelId: string;
  action: Action;
  workspaceId: string;
  sequenceId: string;
}

export interface BootstrapResponse {
  syncActions: SyncActionRecord[];
  lastSequenceId: string;

  /**
   * Set when the server cannot serve a delta from the sequence this client
   * sent — its history belongs to a database this one is not. There is no
   * incremental way back from that, so the client rebuilds from a bootstrap
   * rather than applying an empty delta over a cache that is already wrong.
   */
  resync?: boolean;
}
