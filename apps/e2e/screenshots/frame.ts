import { expect, type Locator, type Page } from '@playwright/test';

/**
 * How a screenshot is framed. A docs page shows one feature at a time, so a
 * capture names what it is about and the image is cut down to that, with a
 * margin of the page around it for context. With no `focus` it is the whole
 * viewport, which suits only the pages that are themselves the subject.
 */
export interface Frame {
  /**
   * What the screenshot is about. The image is the smallest box holding all of
   * them, plus `padding`.
   */
  focus?: Locator | Locator[];
  /** Page kept around the focus, in CSS pixels. */
  padding?: number;
  /**
   * Drawn round in the app's primary colour, to point at the one control the text
   * is about inside a larger frame.
   */
  highlight?: Locator | Locator[];
}

const HIGHLIGHT_ID = 'docs-capture-highlight';

/**
 * Per-run email addresses are unique on the server, so each run signs up with
 * new ones: `ada+k3x9@docs.vantik.test` is shown as `ada@acme.dev`. Agent
 * accounts get a random suffix too, which is dropped.
 */
async function hidePerRunAddresses(page: Page) {
  await page.evaluate(() => {
    const rewrites: Array<[RegExp, string]> = [
      [/([a-z]+)\+[a-z0-9]+@docs\.vantik\.test/g, '$1@acme.dev'],
      [/(agent-[a-z0-9-]+?)-[0-9a-f]{8}@agents\.vantik\.local/g, '$1@agents.vantik.local'],
    ];
    const rewrite = (text: string) =>
      rewrites.reduce((out, [from, to]) => out.replace(from, to), text);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      node.textContent = rewrite(node.textContent!);
    }
    for (const input of document.querySelectorAll('input')) {
      input.value = rewrite(input.value);
    }
  });
}

function list(locators?: Locator | Locator[]) {
  if (!locators) return [];
  return Array.isArray(locators) ? locators : [locators];
}

async function boxes(locators: Locator[]) {
  const found = [];
  for (const locator of locators) {
    await expect(locator).toBeVisible();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`${locator} has no box on the page`);
    found.push(box);
  }
  return found;
}

/** Outlines each box with a ring that sits above the page and takes no clicks. */
async function drawHighlights(
  page: Page,
  rings: Array<{ x: number; y: number; width: number; height: number }>,
) {
  await page.evaluate(
    ({ id, rings }) => {
      document.getElementById(id)?.remove();
      const layer = document.createElement('div');
      layer.id = id;
      layer.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      for (const ring of rings) {
        const outline = document.createElement('div');
        const gap = 4;
        outline.style.cssText = [
          'position:absolute',
          `left:${ring.x - gap}px`,
          `top:${ring.y - gap}px`,
          `width:${ring.width + gap * 2}px`,
          `height:${ring.height + gap * 2}px`,
          'border:2px solid oklch(var(--primary))',
          'border-radius:8px',
          'box-shadow:0 0 0 4px oklch(var(--primary) / 0.2)',
        ].join(';');
        layer.appendChild(outline);
      }
      document.body.appendChild(layer);
    },
    { id: HIGHLIGHT_ID, rings },
  );
}

/**
 * Saves `<name>.png` once the page has settled, framed as `frame` asks. The
 * name may hold folders, as in `issues/list`.
 */
export async function shot(page: Page, name: string, frame: Frame = {}) {
  await page.waitForLoadState('networkidle');
  await hidePerRunAddresses(page);

  const focus = await boxes(list(frame.focus));
  // Boxes are read after every scroll, so they agree with one another.
  const highlight = await boxes(list(frame.highlight));
  if (highlight.length) await drawHighlights(page, highlight);

  const viewport = page.viewportSize()!;
  let clip;
  if (focus.length) {
    const padding = frame.padding ?? 24;
    const left = Math.max(0, Math.min(...focus.map((b) => b.x)) - padding);
    const top = Math.max(0, Math.min(...focus.map((b) => b.y)) - padding);
    const right = Math.min(
      viewport.width,
      Math.max(...focus.map((b) => b.x + b.width)) + padding,
    );
    const bottom = Math.min(
      viewport.height,
      Math.max(...focus.map((b) => b.y + b.height)) + padding,
    );
    // Whole pixels, so the same layout always cuts the same image.
    clip = {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.ceil(right - left),
      height: Math.ceil(bottom - top),
    };
  }

  await expect(page).toHaveScreenshot(`${name}.png`.split('/'), { clip });
  await page.evaluate((id) => document.getElementById(id)?.remove(), HIGHLIGHT_ID);
}
