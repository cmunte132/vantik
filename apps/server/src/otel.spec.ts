import { ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { tracing } from '@opentelemetry/sdk-node';

import { HealthCheckSampler } from './otel';

const sampler = new HealthCheckSampler();

function decide(kind: SpanKind, attributes: Record<string, string>) {
  return sampler.shouldSample(ROOT_CONTEXT, 'trace', 'GET', kind, attributes)
    .decision;
}

describe('HealthCheckSampler', () => {
  it.each([
    [{ 'url.path': '/health/ready' }],
    [{ 'http.target': '/health/ready?probe=1' }],
    [{ 'url.path': '/' }],
    [{ 'url.path': '/v1/telemetry/traces' }],
  ])(
    'drops the server span of a probe or a relayed export: %j',
    (attributes) => {
      expect(decide(SpanKind.SERVER, attributes)).toBe(
        tracing.SamplingDecision.NOT_RECORD,
      );
    },
  );

  it('keeps a real request, and a client call to a health path', () => {
    expect(decide(SpanKind.SERVER, { 'url.path': '/v1/issues' })).toBe(
      tracing.SamplingDecision.RECORD_AND_SAMPLED,
    );
    expect(decide(SpanKind.CLIENT, { 'url.path': '/health' })).toBe(
      tracing.SamplingDecision.RECORD_AND_SAMPLED,
    );
  });
});
