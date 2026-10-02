import {
  BROWSER_SERVICE_NAME,
  parseOtlpHeaders,
  relayTarget,
  sanitiseExport,
} from './otlp-relay';

describe('relayTarget', () => {
  // Telemetry is off by default, and the browser's data is then discarded.
  it('is undefined when no endpoint is configured', () => {
    expect(relayTarget('traces', {})).toBeUndefined();
    expect(
      relayTarget('logs', { OTEL_EXPORTER_OTLP_ENDPOINT: '  ' }),
    ).toBeUndefined();
  });

  it('appends the signal path to the base endpoint, as the exporters do', () => {
    expect(
      relayTarget('traces', {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/',
      })?.url,
    ).toBe('http://collector:4318/v1/traces');
  });

  // OpenObserve, for one, puts an organisation in the path, so its operators
  // set the signal endpoints in full.
  it('uses a signal endpoint as is, ahead of the base', () => {
    expect(
      relayTarget('logs', {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://o2:5080/api/default/v1/logs',
      })?.url,
    ).toBe('http://o2:5080/api/default/v1/logs');
  });

  it('sends the server headers, with signal headers over the general ones', () => {
    expect(
      relayTarget('traces', {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Basic%20abc,x-org=one',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-org=two',
      })?.headers,
    ).toEqual({ authorization: 'Basic abc', 'x-org': 'two' });
  });
});

describe('parseOtlpHeaders', () => {
  it('skips a pair with no key or no equals sign', () => {
    expect(parseOtlpHeaders('novalue,=empty,a=1,b=x=y')).toEqual({
      a: '1',
      b: 'x=y',
    });
  });

  it('keeps a part that is not valid percent-encoding', () => {
    expect(parseOtlpHeaders('a=100%')).toEqual({ a: '100%' });
  });
});

describe('sanitiseExport', () => {
  const serviceNames = (
    body: Record<string, unknown> | undefined,
    key: string,
  ) =>
    (
      body?.[key] as Array<{
        resource: {
          attributes: Array<{ key: string; value: { stringValue: string } }>;
        };
      }>
    ).map((container) =>
      container.resource.attributes
        .filter((attribute) => attribute.key === 'service.name')
        .map((attribute) => attribute.value.stringValue),
    );

  // The relay is unauthenticated, so it must not let a caller post spans that
  // claim to be the server's.
  it('stamps the browser service name over whatever the caller sent', () => {
    const body = sanitiseExport('traces', {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'vantik-server' } },
              { key: 'browser.language', value: { stringValue: 'en' } },
            ],
          },
          scopeSpans: [],
        },
        { scopeSpans: [] },
      ],
    });

    expect(serviceNames(body, 'resourceSpans')).toEqual([
      [BROWSER_SERVICE_NAME],
      [BROWSER_SERVICE_NAME],
    ]);
    expect(JSON.stringify(body)).toContain('browser.language');
  });

  it('keeps only the array for the signal', () => {
    expect(
      Object.keys(
        sanitiseExport('logs', {
          resourceLogs: [],
          resourceSpans: [],
          extra: 1,
        }) ?? {},
      ),
    ).toEqual(['resourceLogs']);
  });

  it.each([null, 'text', [], {}, { resourceSpans: [] }, { resourceLogs: 'x' }])(
    'refuses a body that is not a log export: %j',
    (body) => {
      expect(sanitiseExport('logs', body)).toBeUndefined();
    },
  );
});
