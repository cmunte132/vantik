import { Module } from '@nestjs/common';

import { ConnectorGateway } from './connector.gateway';
import { ConnectorRegistry } from './connector.registry';

/**
 * The server's end of `vantik connect`: the socket namespace local connectors
 * dial, and the registry of who is online. What runs on the connector is the
 * local executor in the agent-runs module, which registers itself as the
 * registry's handler.
 */
@Module({
  providers: [ConnectorRegistry, ConnectorGateway],
  exports: [ConnectorRegistry],
})
export class ConnectorModule {}
