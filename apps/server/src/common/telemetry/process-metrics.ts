import { metrics, ValueType } from '@opentelemetry/api';

/**
 * This function records the memory and the CPU time of the whole process.
 *
 * The runtime instrumentation records only the V8 heap. The process also
 * holds native memory: the Prisma query engine, the allocator arenas of each
 * thread, and the buffers. `process.memory.usage` is the resident set size,
 * so it includes all of that memory. To see the native part, subtract the
 * physical size of the heap spaces from it.
 *
 * The names are the OpenTelemetry semantic conventions for a process. In
 * Prometheus they become `process_memory_usage_bytes` and
 * `process_cpu_time_seconds_total`.
 */
export function registerProcessMetrics(): void {
  const meter = metrics.getMeter('vantik-server');

  const memory = meter.createObservableGauge('process.memory.usage', {
    description:
      'The resident set size of the process: heap and native memory.',
    unit: 'By',
    valueType: ValueType.INT,
  });
  const cpu = meter.createObservableCounter('process.cpu.time', {
    description: 'The CPU time that the process used, for each CPU mode.',
    unit: 's',
    valueType: ValueType.DOUBLE,
  });

  meter.addBatchObservableCallback(
    (result) => {
      result.observe(memory, process.memoryUsage.rss());

      const usage = process.cpuUsage();
      result.observe(cpu, usage.user / 1e6, { 'cpu.mode': 'user' });
      result.observe(cpu, usage.system / 1e6, { 'cpu.mode': 'system' });
    },
    [memory, cpu],
  );
}
