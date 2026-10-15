import { useLayoutEffect, useRef, useState } from 'react';

import { niceMax, scaleLinear } from './utils';

/*
 * Hand-rolled SVG. The chart measures its container and draws in real pixels at
 * a fixed height, so labels keep their size at any page width. Colours are
 * Tailwind classes that read the app's CSS variables, which is what makes them
 * follow the theme.
 */

const HEIGHT = 180;
const FALLBACK_WIDTH = 600;
const PAD = { top: 8, right: 8, bottom: 22, left: 32 };
const TICKS = 4;

const LABEL_CLASS = 'fill-muted-foreground';
const LABEL_SIZE = 10;

/** The container's width in pixels, kept current as the layout changes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      if (element.clientWidth > 0) {
        setWidth(element.clientWidth);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function Frame({
  max,
  children,
}: {
  max: number;
  children: (y: (value: number) => number, width: number) => React.ReactNode;
}) {
  const { ref, width } = useWidth();
  const y = scaleLinear([0, max], [HEIGHT - PAD.bottom, PAD.top]);
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => (max / TICKS) * i);

  return (
    <div ref={ref} className="w-full">
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="block"
        role="img"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={LABEL_SIZE}
              className={LABEL_CLASS}
            >
              {Number(tick.toFixed(1))}
            </text>
          </g>
        ))}
        {children(y, width)}
      </svg>
    </div>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  /** Shown as the tooltip. */
  title: string;
}

export function BarChart({ data }: { data: BarDatum[] }) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));

  return (
    <Frame max={max}>
      {(y, width) => {
        const slot = (width - PAD.left - PAD.right) / Math.max(data.length, 1);
        const barWidth = Math.min(slot * 0.6, 48);

        return data.map((d, i) => {
          const x = PAD.left + slot * i + (slot - barWidth) / 2;
          const top = y(d.value);

          return (
            <g key={`${d.label}-${i}`}>
              <rect
                x={x}
                y={top}
                width={barWidth}
                height={Math.max(HEIGHT - PAD.bottom - top, 0)}
                rx={2}
                className="fill-primary"
              >
                <title>{d.title}</title>
              </rect>
              <text
                x={x + barWidth / 2}
                y={HEIGHT - 8}
                textAnchor="middle"
                fontSize={LABEL_SIZE}
                className={LABEL_CLASS}
              >
                {d.label}
              </text>
            </g>
          );
        });
      }}
    </Frame>
  );
}

export interface LinePoint {
  label: string;
  value: number;
}

/**
 * Both series share the x axis of `ideal`, which spans the whole cycle; the
 * actual series stops at today.
 */
export function LineChart({
  actual,
  ideal,
  unit,
}: {
  actual: LinePoint[];
  ideal: LinePoint[];
  unit: string;
}) {
  const max = niceMax(
    Math.max(0, ...actual.map((p) => p.value), ...ideal.map((p) => p.value)),
  );
  const count = Math.max(ideal.length, actual.length, 2);

  return (
    <Frame max={max}>
      {(y, width) => {
        const x = scaleLinear([0, count - 1], [PAD.left, width - PAD.right]);
        const path = (points: LinePoint[]) =>
          points
            .map(
              (p, i) =>
                `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value)}`,
            )
            .join(' ');
        // About one label per 80px, so narrow charts do not overlap them.
        const labelEvery = Math.max(
          1,
          Math.ceil(count / Math.max(width / 80, 2)),
        );

        return (
          <>
            <path
              d={path(ideal)}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              className="stroke-muted-foreground"
            />
            <path
              d={path(actual)}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              className="stroke-primary"
            />
            {actual.map((p, i) => (
              <circle
                key={p.label}
                cx={x(i)}
                cy={y(p.value)}
                r={2.5}
                className="fill-primary"
              >
                <title>{`${p.label}: ${p.value} ${unit} remaining`}</title>
              </circle>
            ))}
            {ideal.map((p, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={p.label}
                  x={x(i)}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  fontSize={LABEL_SIZE}
                  className={LABEL_CLASS}
                >
                  {p.label}
                </text>
              ) : null,
            )}
          </>
        );
      }}
    </Frame>
  );
}
