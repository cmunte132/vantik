import type {
  KnowledgeMap,
  KnowledgeMapEdge,
  KnowledgeMapEdgeType,
  KnowledgeMapFactState,
  KnowledgeMapLayout,
  KnowledgeMapNode,
} from '@vantikhq/types';

import { getTailwindColor } from '@vantikhq/ui/lib/color-utils';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';

import { useKnowledgeMap } from 'services/pages';

import { GARDEN_COLOR } from '../gardener';
import { Header } from '../header';
import { Chip, type TrustTone } from '../trust';
import { GARDENER_ROUTE } from './routes';

const DAY = 86_400_000;

const LAYOUTS: Array<{ value: KnowledgeMapLayout; label: string }> = [
  { value: 'module', label: 'By module' },
  { value: 'page', label: 'By page' },
  { value: 'product', label: 'By product' },
];

const EDGE_STYLE: Record<
  KnowledgeMapEdgeType,
  { label: string; color: string; dash?: string; width: number }
> = {
  'cites-code': { label: 'cites code', color: GARDEN_COLOR.code, width: 1.3 },
  'cites-issue': {
    label: 'cites an issue',
    color: GARDEN_COLOR.people,
    width: 1.3,
  },
  replaced: { label: 'replaced', color: GARDEN_COLOR.replaced, width: 1.8 },
  contradicts: {
    label: 'contradicts',
    color: GARDEN_COLOR.needYou,
    dash: '5 3',
    width: 1.8,
  },
  refines: { label: 'refines', color: GARDEN_COLOR.refines, width: 1.5 },
  given: {
    label: 'given to runs',
    color: 'oklch(30% 0 0 / 0.35)',
    dash: '1 3',
    width: 1.2,
  },
  'part-of': {
    label: 'part of',
    color: 'oklch(0% 0 0 / 0.14)',
    dash: '2 4',
    width: 1,
  },
};

const LEGEND_EDGES: KnowledgeMapEdgeType[] = [
  'cites-code',
  'cites-issue',
  'replaced',
  'contradicts',
  'refines',
  'given',
  'part-of',
];

const STATE_COLOR: Record<KnowledgeMapFactState, string> = {
  code: GARDEN_COLOR.code,
  people: GARDEN_COLOR.people,
  observed: GARDEN_COLOR.observed,
  provisional: 'oklch(62% 0 0)',
  unconfirmed: 'oklch(78% 0 0)',
  'needs-you': GARDEN_COLOR.needYou,
  waiting: 'oklch(45% 0 0)',
  retired: GARDEN_COLOR.retired,
};

const STATE_LABEL: Record<KnowledgeMapFactState, string> = {
  code: 'code confirms',
  people: 'a person confirmed',
  observed: 'observed',
  provisional: 'provisional',
  unconfirmed: 'unconfirmed',
  'needs-you': 'needs you',
  waiting: 'waiting',
  retired: 'retired',
};

const STATE_CHIP: Partial<Record<KnowledgeMapFactState, TrustTone>> = {
  code: 'code',
  people: 'people',
  observed: 'observed',
  'needs-you': 'needYou',
  retired: 'stale',
};

/** The order of the segments of a state bar. */
const STATE_ORDER: KnowledgeMapFactState[] = [
  'code',
  'people',
  'observed',
  'provisional',
  'unconfirmed',
  'needs-you',
  'waiting',
  'retired',
];

const NO_GROUP = 'none';

interface Placed {
  node: KnowledgeMapNode;
  x: number;
  y: number;
  r: number;
}

interface Hub {
  id: string;
  label: string;
  color: string;
  facts: KnowledgeMapNode[];
  /** A product has no node of its own; its hub stands for it. */
  node?: KnowledgeMapNode;
}

/**
 * The map of what the workspace knows: modules, pages or products, the
 * facts in each, what the facts cite, and the runs they were given to. The
 * slider shows the map as it stood on an earlier day.
 */
const MapView = observer(() => {
  const [layout, setLayout] = React.useState<KnowledgeMapLayout>('module');
  const [day, setDay] = React.useState<number | null>(null);
  const [asOf, setAsOf] = React.useState<string | undefined>();
  const [selected, setSelected] = React.useState<string | null>(null);
  const { data } = useKnowledgeMap(asOf);

  // Ask for a past day once the slider rests, not at every step of a drag.
  React.useEffect(() => {
    const timer = setTimeout(
      () =>
        setAsOf(
          day === null ? undefined : new Date(day).toISOString().slice(0, 10),
        ),
      250,
    );
    return () => clearTimeout(timer);
  }, [day]);

  const hubs = React.useMemo(
    () => (data ? hubsOf(data, layout) : []),
    [data, layout],
  );
  const placed = React.useMemo(
    () => (data ? place(data, hubs) : null),
    [data, hubs],
  );

  const current =
    selected && placed?.byId.has(selected)
      ? selected
      : // The busiest group, until a person picks something.
        ([...hubs].sort((a, b) => b.facts.length - a.facts.length)[0]?.id ??
        null);

  return (
    <MainLayout
      scrollable
      header={
        <Header
          crumbs={[
            { label: 'Gardener', pathname: GARDENER_ROUTE },
            { label: 'Map' },
          ]}
        />
      }
    >
      <div className="flex flex-col h-full min-h-[640px]">
        <div className="flex flex-wrap items-center gap-3.5 px-4 py-2.5 border-b border-grayAlpha-100">
          <div
            className="flex gap-0.5 p-0.5 bg-grayAlpha-100 rounded-lg"
            role="radiogroup"
            aria-label="Group the map"
          >
            {LAYOUTS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={layout === option.value}
                onClick={() => {
                  setLayout(option.value);
                  setSelected(null);
                }}
                className={cn(
                  'px-2.5 py-[3px] rounded-md text-xs',
                  layout === option.value
                    ? 'bg-background-3 font-medium shadow-[0_1px_2px_oklch(0%_0_0/0.08)]'
                    : 'text-foreground/80',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            {LEGEND_EDGES.map((type) => (
              <span
                key={type}
                className="flex items-center gap-1.5 text-xs text-foreground/85 whitespace-nowrap"
              >
                <svg width="18" height="8" aria-hidden>
                  <line
                    x1="0"
                    y1="4"
                    x2="18"
                    y2="4"
                    stroke={EDGE_STYLE[type].color.replace(
                      / \/ [0-9.]+\)/,
                      ')',
                    )}
                    strokeWidth={2}
                    strokeDasharray={EDGE_STYLE[type].dash}
                  />
                </svg>
                {EDGE_STYLE[type].label}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-col md:flex-row grow min-h-0">
          <section className="grow min-w-0 relative min-h-[480px]">
            <div className="absolute top-3 left-4 right-4 flex flex-wrap gap-3 z-10 pointer-events-none">
              {STATE_ORDER.map((state) => (
                <span
                  key={state}
                  className="flex items-center gap-1.5 text-xs text-foreground/85 whitespace-nowrap"
                >
                  <StateDot state={state} />
                  {STATE_LABEL[state]}
                </span>
              ))}
            </div>

            {placed && data && (
              <MapCanvas
                data={data}
                placed={placed}
                hubs={hubs}
                selected={current}
                onSelect={setSelected}
              />
            )}
            {data && data.nodes.every((node) => node.type !== 'fact') && (
              <div className="absolute inset-0 flex items-center justify-center text-foreground/75">
                No facts on this day.
              </div>
            )}

            {data && (
              <Slider data={data} day={day} onDay={(value) => setDay(value)} />
            )}
          </section>

          <aside className="md:w-[330px] shrink-0 border-t md:border-t-0 md:border-l border-grayAlpha-100 bg-background-3 p-[18px] flex flex-col gap-4 overflow-y-auto">
            {data && current && placed && (
              <Detail
                data={data}
                hubs={hubs}
                id={current}
                layout={layout}
                onSelect={setSelected}
              />
            )}
          </aside>
        </div>
      </div>
    </MainLayout>
  );
});

function StateDot({ state }: { state: KnowledgeMapFactState }) {
  if (state === 'waiting' || state === 'retired') {
    return (
      <span
        className="size-2 rounded-full"
        style={{
          border: `1.5px ${state === 'waiting' ? 'dashed' : 'solid'} ${STATE_COLOR[state]}`,
        }}
      />
    );
  }

  return (
    <span
      className="size-2.5 rounded-full"
      style={{ background: STATE_COLOR[state] }}
    />
  );
}

/** The group a fact belongs to in a layout. */
function groupOf(
  fact: KnowledgeMapNode,
  layout: KnowledgeMapLayout,
  productOfModule: Map<string, string | null>,
): string {
  if (layout === 'page') {
    return fact.pageId ?? NO_GROUP;
  }

  const first = fact.moduleIds?.[0];

  if (layout === 'module') {
    return first ?? NO_GROUP;
  }

  return (first && productOfModule.get(first)) || NO_GROUP;
}

function hubsOf(data: KnowledgeMap, layout: KnowledgeMapLayout): Hub[] {
  const productOfModule = new Map(
    data.nodes
      .filter((node) => node.type === 'module')
      .map((node) => [node.id, node.productId ?? null]),
  );
  // A product without a colour of its own gets the one its swatch shows.
  const colorOf = new Map(
    data.products.map((product) => [
      product.id,
      product.color ?? getTailwindColor(product.name),
    ]),
  );
  const hubs = new Map<string, Hub>();

  const hubFor = (id: string): Hub => {
    const existing = hubs.get(id);
    if (existing) {
      return existing;
    }

    const node = data.nodes.find((candidate) => candidate.id === id);
    const product = data.products.find((candidate) => candidate.id === id);
    const hub: Hub = {
      id,
      label:
        id === NO_GROUP
          ? layout === 'page'
            ? 'On no page'
            : layout === 'module'
              ? 'In no module'
              : 'In no product'
          : (node?.label ?? product?.name ?? 'Unknown'),
      color:
        (node?.productId && colorOf.get(node.productId)) ||
        (product && colorOf.get(product.id)) ||
        GARDEN_COLOR.grey,
      facts: [],
      node,
    };
    hubs.set(id, hub);
    return hub;
  };

  // Every module is on the module map, with facts or without.
  if (layout === 'module') {
    data.nodes
      .filter((node) => node.type === 'module')
      .forEach((node) => hubFor(node.id));
  }

  for (const fact of data.nodes.filter((node) => node.type === 'fact')) {
    hubFor(groupOf(fact, layout, productOfModule)).facts.push(fact);
  }

  return [...hubs.values()].sort(
    (a, b) =>
      Number(a.id === NO_GROUP) - Number(b.id === NO_GROUP) ||
      b.facts.length - a.facts.length ||
      a.label.localeCompare(b.label),
  );
}

/**
 * Places every node. The biggest group sits in the middle, and each next
 * group takes the first free place on a spiral around it. Facts circle their
 * group, and the files and issues they cite circle outside them. A page or
 * module that is not a group sits by the facts it holds. Runs stand in a
 * column on the right. The same data always gives the same map.
 */
function place(data: KnowledgeMap, hubs: Hub[]) {
  const byId = new Map<string, Placed>();
  const cited = new Map<string, string>();

  for (const edge of data.edges) {
    if (
      (edge.type === 'cites-code' || edge.type === 'cites-issue') &&
      !cited.has(edge.to)
    ) {
      cited.set(edge.to, edge.from);
    }
  }

  const factHub = new Map<string, Hub>();
  hubs.forEach((hub) => hub.facts.forEach((fact) => factHub.set(fact.id, hub)));

  const citedBy = new Map<Hub, KnowledgeMapNode[]>();
  for (const node of data.nodes) {
    if (node.type === 'file' || node.type === 'issue') {
      const hub = factHub.get(cited.get(node.id) ?? '');
      if (hub) {
        citedBy.set(hub, [...(citedBy.get(hub) ?? []), node]);
      }
    }
  }

  // The radius each group needs, with its facts and what they cite.
  const extent = hubs.map((hub) => {
    const r = 16 + Math.sqrt(hub.facts.length) * 5;
    const rings = ringsFor(hub.facts.length, r + 22, 17);
    const outer = rings.length ? rings[rings.length - 1].radius : r;
    return { hub, r, rings, outer, citeRadius: outer + 34 };
  });
  const taken: Array<{ x: number; y: number; r: number }> = [];

  extent.forEach((each) => {
    const room = (each.hub.facts.length ? each.citeRadius : each.r) + 24;
    let cx = 0;
    let cy = 0;

    // Walk out along the spiral to the first place that overlaps nothing.
    for (let step = 0; step < 4000; step += 1) {
      const angle = step * 0.35;
      const distance = step * 3;
      cx = Math.cos(angle) * distance;
      cy = Math.sin(angle) * distance;
      if (
        taken.every(
          (other) => Math.hypot(other.x - cx, other.y - cy) >= other.r + room,
        )
      ) {
        break;
      }
    }
    taken.push({ x: cx, y: cy, r: room });
    const hubNode: KnowledgeMapNode = each.hub.node ?? {
      id: each.hub.id,
      type: 'module',
      label: each.hub.label,
    };

    byId.set(each.hub.id, { node: hubNode, x: cx, y: cy, r: each.r });

    let offset = 0;
    each.rings.forEach((ring) => {
      for (let slot = 0; slot < ring.count; slot += 1) {
        const fact = each.hub.facts[offset + slot];
        const theta = (slot / ring.count) * Math.PI * 2 + ring.radius / 40;
        byId.set(fact.id, {
          node: fact,
          x: cx + Math.cos(theta) * ring.radius,
          y: cy + Math.sin(theta) * ring.radius,
          r: 6.5,
        });
      }
      offset += ring.count;
    });

    const cites = citedBy.get(each.hub) ?? [];
    cites.forEach((node, slot) => {
      const theta = (slot / Math.max(cites.length, 1)) * Math.PI * 2 + 0.3;
      byId.set(node.id, {
        node,
        x: cx + Math.cos(theta) * each.citeRadius,
        y: cy + Math.sin(theta) * each.citeRadius,
        r: 5,
      });
    });
  });

  const bounds = boundsOf([...byId.values()]);
  const runs = data.nodes.filter((node) => node.type === 'run');
  const step = Math.max(
    28,
    (bounds.maxY - bounds.minY) / Math.max(runs.length, 1),
  );

  runs.forEach((node, index) => {
    byId.set(node.id, {
      node,
      x: bounds.maxX + 140,
      y: bounds.minY + index * step,
      r: 5,
    });
  });

  // The pages and modules that are not groups here: by the facts they hold,
  // or in a row above everything when they hold none on the map.
  const rest = data.nodes.filter((node) => !byId.has(node.id));
  let row = 0;
  rest.forEach((node) => {
    const held = data.edges
      .filter((edge) => edge.to === node.id && byId.has(edge.from))
      .map((edge) => byId.get(edge.from) as Placed);

    if (held.length) {
      const x = held.reduce((sum, point) => sum + point.x, 0) / held.length;
      const y = held.reduce((sum, point) => sum + point.y, 0) / held.length;
      byId.set(node.id, { node, x: x + 14, y: y - 14, r: 6 });
    } else {
      byId.set(node.id, {
        node,
        x: bounds.minX + (row % 6) * 160,
        y: bounds.minY - 60 - Math.floor(row / 6) * 24,
        r: 6,
      });
      row += 1;
    }
  });

  return { byId, bounds: boundsOf([...byId.values()]) };
}

function ringsFor(count: number, first: number, gap: number) {
  const rings: Array<{ radius: number; count: number }> = [];
  let left = count;
  let radius = first;

  while (left > 0) {
    const fits = Math.max(6, Math.floor((2 * Math.PI * radius) / 17));
    rings.push({ radius, count: Math.min(fits, left) });
    left -= fits;
    radius += gap;
  }

  return rings;
}

function boundsOf(points: Placed[]) {
  return points.reduce(
    (box, point) => ({
      minX: Math.min(box.minX, point.x - point.r),
      minY: Math.min(box.minY, point.y - point.r),
      maxX: Math.max(box.maxX, point.x + point.r),
      maxY: Math.max(box.maxY, point.y + point.r),
    }),
    { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  );
}

function MapCanvas({
  data,
  placed,
  hubs,
  selected,
  onSelect,
}: {
  data: KnowledgeMap;
  placed: ReturnType<typeof place>;
  hubs: Hub[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { byId, bounds } = placed;
  const pad = 80;
  const viewBox = [
    bounds.minX - pad,
    bounds.minY - pad - 30,
    bounds.maxX - bounds.minX + pad * 2 + 60,
    bounds.maxY - bounds.minY + pad * 2 + 90,
  ].join(' ');
  const hubIds = new Set(hubs.map((hub) => hub.id));
  const factHub = new Map<string, string>();
  hubs.forEach((hub) =>
    hub.facts.forEach((fact) => factHub.set(fact.id, hub.id)),
  );

  // A fact joins its group by a spoke; other part-of edges are drawn as data.
  const spokes = hubs.flatMap((hub) =>
    hub.facts.map((fact) => ({ from: fact.id, to: hub.id })),
  );
  const edges = data.edges.filter(
    (edge) =>
      byId.has(edge.from) &&
      byId.has(edge.to) &&
      !(
        edge.type === 'part-of' &&
        (factHub.get(edge.from) === edge.to ||
          data.nodes.find((node) => node.id === edge.from)?.type === 'fact')
      ),
  );
  const focus = selected ? neighbours(data.edges, selected, factHub) : null;

  return (
    <svg
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 w-full h-full"
      role="img"
      aria-label="Map of what the workspace knows"
    >
      <defs>
        <marker
          id="map-arrow"
          viewBox="0 0 10 10"
          refX="16"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 L10 5 L0 10 z" fill={GARDEN_COLOR.replaced} />
        </marker>
      </defs>

      {spokes.map((spoke) => {
        const a = byId.get(spoke.from);
        const b = byId.get(spoke.to);
        return a && b ? (
          <line
            key={`spoke-${spoke.from}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="oklch(0% 0 0 / 0.12)"
            strokeWidth={1}
            className="dark:stroke-[oklch(100%_0_0/0.14)]"
          />
        ) : null;
      })}

      {edges.map((edge, index) => (
        <Edge
          key={`${edge.type}-${edge.from}-${edge.to}-${index}`}
          edge={edge}
          from={byId.get(edge.from) as Placed}
          to={byId.get(edge.to) as Placed}
          dim={
            Boolean(focus) && !(focus?.has(edge.from) && focus?.has(edge.to))
          }
        />
      ))}

      {[...byId.values()].map((point) =>
        hubIds.has(point.node.id) ? (
          <HubNode
            key={point.node.id}
            point={point}
            hub={hubs.find((hub) => hub.id === point.node.id) as Hub}
            selected={selected === point.node.id}
            onSelect={onSelect}
          />
        ) : (
          <MapNode
            key={point.node.id}
            point={point}
            selected={selected === point.node.id}
            dim={Boolean(focus) && !focus?.has(point.node.id)}
            labelled={
              selected === point.node.id ||
              (Boolean(focus?.has(point.node.id)) &&
                !hubIds.has(selected ?? ''))
            }
            onSelect={onSelect}
          />
        ),
      )}
    </svg>
  );
}

/** The ids joined to a node, and to its facts when it is a group. */
function neighbours(
  edges: KnowledgeMapEdge[],
  id: string,
  factHub: Map<string, string>,
): Set<string> {
  const near = new Set([id]);

  factHub.forEach((hub, fact) => {
    if (hub === id) {
      near.add(fact);
    }
  });
  // One step out from the node and its facts, and no further.
  const seeds = new Set(near);

  for (const edge of edges) {
    if (seeds.has(edge.from)) {
      near.add(edge.to);
    } else if (seeds.has(edge.to)) {
      near.add(edge.from);
    }
  }

  return near;
}

function Edge({
  edge,
  from,
  to,
  dim,
}: {
  edge: KnowledgeMapEdge;
  from: Placed;
  to: Placed;
  dim: boolean;
}) {
  const style = EDGE_STYLE[edge.type];

  return (
    <line
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
      stroke={style.color}
      strokeWidth={style.width}
      strokeDasharray={style.dash}
      markerEnd={edge.type === 'replaced' ? 'url(#map-arrow)' : undefined}
      opacity={dim ? 0.15 : 1}
    />
  );
}

function HubNode({
  point,
  hub,
  selected,
  onSelect,
}: {
  point: Placed;
  hub: Hub;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const label = hub.label;
  const width = Math.min(label.length, 28) * 7 + 16;

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${label}, ${hub.facts.length} facts`}
      className="cursor-pointer focus:outline-none"
      onClick={() => onSelect(hub.id)}
      onKeyDown={(event) => event.key === 'Enter' && onSelect(hub.id)}
    >
      {selected && (
        <circle
          cx={point.x}
          cy={point.y}
          r={point.r + 7}
          fill="none"
          stroke={GARDEN_COLOR.people}
          strokeWidth={2.5}
        />
      )}
      <circle
        cx={point.x}
        cy={point.y}
        r={point.r}
        fill={hub.color}
        stroke="#fff"
        strokeWidth={2}
      />
      <text
        x={point.x}
        y={point.y + 5}
        textAnchor="middle"
        fontSize={point.r > 26 ? 15 : 13}
        fontWeight={600}
        fill="#fff"
      >
        {hub.facts.length}
      </text>
      <rect
        x={point.x - width / 2}
        y={point.y + point.r + 6}
        width={width}
        height={20}
        rx={6}
        className="fill-background-3 stroke-grayAlpha-300"
      />
      <text
        x={point.x}
        y={point.y + point.r + 20}
        textAnchor="middle"
        fontSize={11.5}
        className="fill-foreground"
      >
        {label.length > 28 ? `${label.slice(0, 27)}…` : label}
      </text>
    </g>
  );
}

function MapNode({
  point,
  selected,
  dim,
  labelled,
  onSelect,
}: {
  point: Placed;
  selected: boolean;
  dim: boolean;
  /** Whether it is near what is selected, and so shows its name. */
  labelled: boolean;
  onSelect: (id: string) => void;
}) {
  const { node, x, y } = point;
  const common = {
    role: 'button',
    tabIndex: 0,
    'aria-label': node.label,
    className: 'cursor-pointer focus:outline-none',
    opacity: dim ? 0.25 : 1,
    onClick: () => onSelect(node.id),
    onKeyDown: (event: React.KeyboardEvent) =>
      event.key === 'Enter' && onSelect(node.id),
  };

  if (node.type === 'fact') {
    const state = node.state ?? 'unconfirmed';
    const hollow = state === 'waiting' || state === 'retired';

    return (
      <g {...common}>
        <title>{node.label}</title>
        {selected && (
          <circle
            cx={x}
            cy={y}
            r={11}
            fill="none"
            stroke={GARDEN_COLOR.people}
            strokeWidth={2}
          />
        )}
        <circle
          cx={x}
          cy={y}
          r={hollow ? 5.5 : 6.5}
          fill={hollow ? '#fff' : STATE_COLOR[state]}
          stroke={hollow ? STATE_COLOR[state] : '#fff'}
          strokeWidth={1.5}
          strokeDasharray={state === 'waiting' ? '2 1.5' : undefined}
        />
      </g>
    );
  }

  if ((node.type === 'file' || node.type === 'issue') && !labelled) {
    const color =
      node.type === 'file' ? GARDEN_COLOR.code : GARDEN_COLOR.people;

    return (
      <g {...common}>
        <title>{node.label}</title>
        <rect
          x={x - 4}
          y={y - 4}
          width={8}
          height={8}
          rx={2}
          fill={color}
          fillOpacity={0.25}
          stroke={color}
          strokeWidth={1}
        />
      </g>
    );
  }

  if (node.type === 'file' || node.type === 'issue') {
    const text =
      node.type === 'file'
        ? (node.label.split('/').pop() ?? node.label)
        : node.label;
    const width = text.length * 6.4 + 12;
    const color =
      node.type === 'file' ? GARDEN_COLOR.code : GARDEN_COLOR.people;

    return (
      <g {...common}>
        <title>{node.label}</title>
        <rect
          x={x - width / 2}
          y={y - 9}
          width={width}
          height={18}
          rx={4}
          fill={color}
          fillOpacity={0.12}
          stroke={selected ? GARDEN_COLOR.people : color}
          strokeOpacity={selected ? 1 : 0.6}
          strokeWidth={selected ? 2 : 1}
        />
        <text
          x={x}
          y={y + 4}
          textAnchor="middle"
          fontSize={10.5}
          className="font-mono"
          fill={
            node.type === 'file' ? 'oklch(42% 0.1 154)' : 'oklch(45% 0.13 240)'
          }
        >
          {text}
        </text>
      </g>
    );
  }

  if (node.type === 'run') {
    const fill =
      node.outcome === 'wrong'
        ? GARDEN_COLOR.retired
        : node.outcome === 'well'
          ? GARDEN_COLOR.code
          : 'oklch(40% 0 0)';

    return (
      <g {...common}>
        <title>{node.label}</title>
        <rect
          x={x - 5}
          y={y - 5}
          width={10}
          height={10}
          rx={2}
          fill={fill}
          stroke={selected ? GARDEN_COLOR.people : 'none'}
          strokeWidth={2}
        />
        <text x={x + 10} y={y + 4} fontSize={11} className="fill-foreground/85">
          {node.issueKey ?? 'A run'}
        </text>
      </g>
    );
  }

  // A page or module that is not a group here.
  return (
    <g {...common}>
      <title>{node.label}</title>
      <rect
        x={x - 4}
        y={y - 5}
        width={8}
        height={10}
        rx={1.5}
        fill="none"
        stroke="oklch(45% 0.13 240)"
        strokeWidth={1.3}
      />
      <text
        x={x + 9}
        y={y + 4}
        fontSize={12}
        fontWeight={500}
        className="fill-foreground"
      >
        {node.label}
      </text>
    </g>
  );
}

function Slider({
  data,
  day,
  onDay,
}: {
  data: KnowledgeMap;
  day: number | null;
  onDay: (day: number | null) => void;
}) {
  const today = startOfDay(Date.now());
  const first = data.since ? startOfDay(new Date(data.since).getTime()) : today;
  const span = Math.max(today - first, DAY);
  const value = day ?? today;
  const at = (time: string | Date) =>
    `${Math.min(100, Math.max(0, ((startOfDay(new Date(time).getTime()) - first) / span) * 100))}%`;
  const markColor = {
    replaced: GARDEN_COLOR.replaced,
    retired: GARDEN_COLOR.retired,
    contradicts: GARDEN_COLOR.needYou,
  };

  return (
    <div className="absolute left-4 right-4 bottom-3.5 z-10 flex items-center gap-3 bg-background-3 border border-grayAlpha-100 rounded-[10px] px-3.5 py-2">
      <label
        htmlFor="map-as-of"
        className="text-xs font-medium whitespace-nowrap"
      >
        As of {value >= today ? 'today' : formatDay(value)}
      </label>
      <div className="grow relative h-[18px]">
        {data.marks.map((mark, index) => (
          <span
            key={index}
            className="absolute top-[3px] w-0.5 h-3 pointer-events-none"
            style={{ left: at(mark.at), background: markColor[mark.type] }}
          />
        ))}
        <input
          id="map-as-of"
          type="range"
          min={first}
          max={today}
          step={DAY}
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            onDay(next >= today ? null : next);
          }}
          className="absolute inset-0 w-full accent-[oklch(60%_0.13_240)] bg-transparent"
        />
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
        {value > first
          ? `Drag back to ${formatDay(first)} to see the garden grow`
          : 'The day the first fact was written'}
      </span>
    </div>
  );
}

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatDay(time: number) {
  return new Date(time).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** What the map knows about the node a person picked. */
function Detail({
  data,
  hubs,
  id,
  layout,
  onSelect,
}: {
  data: KnowledgeMap;
  hubs: Hub[];
  id: string;
  layout: KnowledgeMapLayout;
  onSelect: (id: string) => void;
}) {
  const node = data.nodes.find((candidate) => candidate.id === id);
  const hub = hubs.find((candidate) => candidate.id === id);
  const factById = new Map(
    data.nodes
      .filter((candidate) => candidate.type === 'fact')
      .map((fact) => [fact.id, fact]),
  );
  const runsOf = new Map(data.factUse.map((use) => [use.entryId, use.runs]));

  const facts = hub
    ? hub.facts
    : node?.type === 'fact'
      ? [node]
      : data.edges
          .filter((edge) => edge.to === id && factById.has(edge.from))
          .map((edge) => factById.get(edge.from) as KnowledgeMapNode);
  const ids = new Set(facts.map((fact) => fact.id));

  const kind = hub
    ? layout === 'product' && !node
      ? 'product'
      : (node?.type ?? layout)
    : (node?.type ?? '');
  const product = data.products.find(
    (candidate) => candidate.id === (node?.productId ?? id),
  );
  const pagesLinking = node
    ? data.edges.filter(
        (edge) =>
          edge.type === 'part-of' &&
          edge.to === id &&
          data.nodes.find((candidate) => candidate.id === edge.from)?.type ===
            'page',
      ).length
    : 0;

  const counts = countStates(facts);
  const use = data.moduleUse.find((row) => row.moduleId === id);
  const given = facts.reduce(
    (sum, fact) => sum + (runsOf.get(fact.id) ?? 0),
    0,
  );

  const tension = data.edges.filter(
    (edge) =>
      (edge.type === 'contradicts' || edge.type === 'replaced') &&
      (ids.has(edge.from) || ids.has(edge.to)),
  );
  const most = [...facts]
    .filter((fact) => runsOf.get(fact.id))
    .sort((a, b) => (runsOf.get(b.id) ?? 0) - (runsOf.get(a.id) ?? 0))
    .slice(0, 3);

  const connected =
    node?.type === 'fact'
      ? data.edges
          .filter(
            (edge) =>
              (edge.from === id || edge.to === id) && edge.type !== 'given',
          )
          .map((edge) => ({
            edge,
            other: data.nodes.find(
              (candidate) =>
                candidate.id === (edge.from === id ? edge.to : edge.from),
            ),
          }))
          .filter((row) => row.other)
      : [];

  const label = hub?.label ?? node?.label ?? 'Unknown';

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <span
            className={cn(
              'text-base font-medium grow leading-snug break-words min-w-0',
            )}
          >
            {label}
          </span>
          <span className="text-xs text-muted-foreground pt-1">{kind}</span>
        </div>
        {kind === 'module' && (
          <span className="text-foreground/80">
            {[
              product?.name ?? 'In no product',
              `${pagesLinking} page${pagesLinking === 1 ? '' : 's'} link to it`,
            ].join(' · ')}
          </span>
        )}
        {node?.type === 'fact' && node.state && (
          <div className="flex gap-1.5 items-center">
            <Chip tone={STATE_CHIP[node.state]}>{STATE_LABEL[node.state]}</Chip>
            <span className="text-xs text-muted-foreground">
              {node.kind?.toLowerCase()} · given to {runsOf.get(id) ?? 0} runs
            </span>
          </div>
        )}
        {node?.type === 'run' && (
          <span className="text-foreground/80">
            {node.outcome === 'well'
              ? 'Went well with the facts it got'
              : node.outcome === 'wrong'
                ? 'Went wrong with a fact it got'
                : 'No signal about its facts yet'}
          </span>
        )}
      </div>

      {facts.length > 0 && node?.type !== 'fact' && (
        <>
          <StateBar counts={counts} />
          <div className="flex flex-col gap-1.5">
            <Row
              label="Facts"
              value={[
                facts.length - (counts.retired ?? 0),
                counts.waiting ? `${counts.waiting} waiting` : null,
                counts['needs-you'] ? `${counts['needs-you']} need you` : null,
                counts.retired ? `${counts.retired} retired` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <Row
              label="Given to agent runs, 30 days"
              value={
                use ? `${use.given} times · ${use.runs} runs` : `${given} runs`
              }
            />
            {use && (
              <>
                <Row label="Runs that went well with them" value={use.well} />
                <Row label="Runs that went wrong with them" value={use.wrong} />
              </>
            )}
          </div>
        </>
      )}

      {tension.length > 0 && (
        <List title="Tension">
          {tension.slice(0, 4).map((edge) => {
            // For one fact, the fact at the other end of the edge.
            const fact = factById.get(
              node?.type === 'fact' && edge.from === id ? edge.to : edge.from,
            );
            return (
              <FactLine
                key={`${edge.type}-${edge.from}-${edge.to}`}
                label={fact?.label ?? 'A fact'}
                chip={
                  edge.type === 'contradicts' ? (
                    <Chip tone="needYou">Contradicts a fact</Chip>
                  ) : (
                    <Chip tone="code">Replaced a fact</Chip>
                  )
                }
                note={fact?.state === 'needs-you' ? 'in Needs you' : undefined}
                onClick={() => fact && onSelect(fact.id)}
              />
            );
          })}
        </List>
      )}

      {most.length > 0 && node?.type !== 'fact' && (
        <List title="Given to runs most">
          {most.map((fact) => (
            <FactLine
              key={fact.id}
              label={fact.label}
              chip={
                fact.state ? (
                  <Chip tone={STATE_CHIP[fact.state]}>
                    {STATE_LABEL[fact.state]}
                  </Chip>
                ) : null
              }
              note={`${runsOf.get(fact.id)} runs`}
              onClick={() => onSelect(fact.id)}
            />
          ))}
        </List>
      )}

      {connected.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-foreground/75">
            Connected to
          </span>
          {connected.map(({ edge, other }) => (
            <button
              key={`${edge.type}-${edge.from}-${edge.to}`}
              type="button"
              onClick={() => other && onSelect(other.id)}
              className="text-left leading-snug break-all"
            >
              <span
                className={cn(
                  (other?.type === 'file' || other?.type === 'module') &&
                    'font-mono',
                )}
              >
                {other?.label}
              </span>
              <span className="text-muted-foreground">
                {' '}
                · {EDGE_STYLE[edge.type].label}
              </span>
            </button>
          ))}
        </div>
      )}

      {node?.type !== 'fact' && facts.length === 0 && (
        <span className="text-foreground/75">No facts here on this day.</span>
      )}
    </>
  );
}

function countStates(facts: KnowledgeMapNode[]) {
  const counts: Partial<Record<KnowledgeMapFactState, number>> = {};
  facts.forEach((fact) => {
    const state = fact.state ?? 'unconfirmed';
    counts[state] = (counts[state] ?? 0) + 1;
  });
  return counts;
}

function StateBar({
  counts,
}: {
  counts: Partial<Record<KnowledgeMapFactState, number>>;
}) {
  return (
    <div className="flex h-2 rounded overflow-hidden gap-0.5" aria-hidden>
      {STATE_ORDER.filter((state) => counts[state]).map((state) => (
        <div
          key={state}
          style={{
            flexGrow: counts[state],
            background:
              state === 'waiting' ? 'oklch(80% 0 0)' : STATE_COLOR[state],
          }}
        />
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="grow text-foreground/80">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function List({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs font-semibold text-foreground/75 pb-1">
        {title}
      </span>
      {children}
    </div>
  );
}

function FactLine({
  label,
  chip,
  note,
  onClick,
}: {
  label: string;
  chip: React.ReactNode;
  note?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-[3px] py-2 border-t border-grayAlpha-100 text-left"
    >
      <span className="leading-snug">{label}</span>
      <span className="flex gap-1.5 items-center">
        {chip}
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </span>
    </button>
  );
}

export function KnowledgeMapPage() {
  return <MapView />;
}

KnowledgeMapPage.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};
