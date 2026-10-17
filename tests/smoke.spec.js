import { expect, test } from '@playwright/test';

for (const path of ['/', '/Lab-Website/']) {
  test(`production page loads at ${path}`, async ({ page, baseURL }) => {
    const localErrors = [];
    const origin = new URL(baseURL).origin;
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400 && !url.pathname.endsWith('/favicon.ico')) {
        localErrors.push(`${response.status()} ${url.pathname}`);
      }
    });

    await page.goto(path, { waitUntil: 'load' });
    await expect(page).toHaveTitle('先進製程與設備智能輔助實驗室');
    await page.waitForFunction(() => window.React && window.ReactDOM && window.STORY_DATA && window.RESEARCH_DATA);
    await expect(page.locator('#dc-root')).toBeVisible();
    await expect(page.locator('h1').first()).toContainText('實驗室');

    const heroWidth = await page.locator('img[fetchpriority="high"]').first().evaluate((image) => image.naturalWidth);
    expect(heroWidth).toBeGreaterThan(0);

    const modules = await page.evaluate(async () => {
      const [three, scene, timeline] = await Promise.all([
        import('./assets/vendor/three/three.module.min.js'),
        import('./assets/js/factory-scene.js'),
        import('./assets/js/story-timeline.js'),
      ]);
      return [typeof three.WebGLRenderer, typeof scene.buildScene, Object.keys(timeline).length > 0];
    });
    expect(modules).toEqual(['function', 'function', true]);
    expect(localErrors).toEqual([]);
  });
}

async function waitForApp(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.React && window.ReactDOM && window.STORY_DATA && document.querySelector('#dc-root'));
}

function contrastRatio(foreground, background) {
  const parse = (value) => {
    const rgb = value.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
    const channels = rgb
      ? rgb.slice(1).map(Number)
      : hex
        ? (hex[1].length === 3 ? [...hex[1]].map((digit) => parseInt(digit + digit, 16)) : hex[1].match(/../g).map((pair) => parseInt(pair, 16)))
        : null;
    if (!channels) throw new Error(`Unsupported color: ${value}`);
    return channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
  };
  const luminance = (value) => {
    const [red, green, blue] = parse(value);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test('language metadata and publication view radios stay synchronized across reentry', async ({ page }) => {
  await waitForApp(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
  await expect(page.locator('html')).toHaveAttribute('data-lang', 'zh');

  const nav = page.locator('.desktop-nav .navlink');
  await nav.nth(4).click();
  const list = page.getByRole('radio', { name: '清單模式' });
  const graph = page.getByRole('radio', { name: '關聯圖' });
  await expect(list).toBeVisible();
  await expect(list).toHaveAccessibleName('清單模式');
  await expect(graph).toHaveAccessibleName('關聯圖');
  await expect(list).toBeChecked();
  await expect(graph).not.toBeChecked();

  await page.locator('label[for="pubview-graph"] .name').click();
  await expect(graph).toBeChecked();
  await expect(list).not.toBeChecked();
  await graph.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(list).toBeChecked();
  await expect(graph).not.toBeChecked();

  await nav.nth(1).click();
  await nav.nth(4).click();
  await expect(list).toBeChecked();
  await expect(graph).not.toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
  await expect(page.locator('html')).toHaveAttribute('data-lang', 'zh');

  await page.locator('.desktop-nav .lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('data-lang', 'en');
  await expect(page.getByRole('radio', { name: 'List' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Graph' })).not.toBeChecked();
  await page.locator('label[for="pubview-graph"] .name').click();
  await expect(page.getByRole('radio', { name: 'Graph' })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  const graphEn = page.getByRole('radio', { name: 'Graph' });
  await graphEn.focus();
  await page.keyboard.press('Space');
  const whiteFocus = await page.evaluate(() => {
    const name = document.querySelector('#pubview-graph + .name');
    const input = document.querySelector('#pubview-graph');
    const style = getComputedStyle(name);
    const matchingRule = [...document.styleSheets].flatMap((sheet) => {
      try { return [...sheet.cssRules]; } catch { return []; }
    }).find((rule) => rule.selectorText === '.radio-inputs .radio input:focus-visible + .name');
    return {
      focused: document.activeElement === input,
      focusVisible: input.matches(':focus-visible'),
      matchingRule: matchingRule?.cssText || '',
      visibleIndicator: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
      background: getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
      outline: getComputedStyle(document.documentElement).getPropertyValue('--color-accent-800').trim(),
    };
  });
  expect(whiteFocus.focused).toBe(true);
  expect(whiteFocus.focusVisible).toBe(true);
  expect(whiteFocus.visibleIndicator).toBe(true);
  expect(whiteFocus.matchingRule).toContain('outline: 2px');
  expect(whiteFocus.matchingRule).toContain('outline-offset: 3px');
  expect(contrastRatio(whiteFocus.outline, whiteFocus.background)).toBeGreaterThanOrEqual(3);

  await page.locator('.desktop-nav .lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
  await expect(page.locator('html')).toHaveAttribute('data-lang', 'zh');
  await expect(page.getByRole('radio', { name: '關聯圖' })).toBeChecked();

  const focusStyles = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules];
      } catch {
        return [];
      }
    });
    const radioRule = rules.find((rule) => rule.selectorText?.includes('.radio-inputs .radio input:focus-visible'));
    const darkRule = rules.find((rule) => rule.selectorText?.includes('.technique-card__face--back'));
    return {
      radioName: document.querySelector('label[for="pubview-graph"]')?.textContent.trim(),
      radioTabIndex: document.querySelector('#pubview-graph')?.tabIndex,
      radioRule: radioRule?.cssText || '',
      darkRule: darkRule?.cssText || '',
      darkRing: getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
      darkSurface: getComputedStyle(document.documentElement).getPropertyValue('--color-accent-900').trim(),
    };
  });
  expect(focusStyles.radioName).toContain('Graph');
  expect(focusStyles.radioTabIndex).toBe(0);
  expect(focusStyles.radioRule).toContain('outline: 2px');
  expect(focusStyles.radioRule).toContain('outline-offset: 3px');
  expect(focusStyles.radioRule).toContain('var(--color-accent-800)');
  expect(focusStyles.darkRule).toContain('var(--color-surface)');
  expect(focusStyles.darkRule).toContain('outline: 2px');
  expect(focusStyles.darkRule).toContain('a:focus-visible');
  expect(contrastRatio(focusStyles.darkRing, focusStyles.darkSurface)).toBeGreaterThanOrEqual(3);
});

test('boot shell keeps its fallback while styles.css is blocked', async ({ page }) => {
  let releaseStyles;
  const stylesReady = new Promise((resolve) => { releaseStyles = resolve; });
  await page.route('**/assets/design/styles.css', async (route) => {
    await stylesReady;
    await route.continue();
  });

  const navigation = page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#boot');
  const fallback = await page.locator('#boot').evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, font: style.fontFamily };
  });
  expect(fallback).toEqual({
    background: 'rgb(242, 242, 243)',
    color: 'rgb(31, 45, 61)',
    font: expect.stringContaining('Barlow'),
  });
  releaseStyles();
  await navigation;
});

test('transit directions use verified exits and the same Banqiao transfer in both languages', async ({ page }) => {
  await waitForApp(page);
  await page.locator('.desktop-nav .navlink').nth(5).click();
  const directions = page.locator('.transit-list');
  await expect(directions).toContainText('南勢角站」，4 號出口');
  await expect(directions).toContainText('F512 副線 — 南勢角站 4 號出口');
  await page.locator('.desktop-nav .lang-toggle').click();
  await expect(directions).toContainText('Nanshijiao Station. From Exit 4');
  await expect(directions).toContainText('F512 (branch line) — board at Nanshijiao Station Exit 4');

  await page.locator('.transit-tabs .transit-tab').nth(4).click();
  await expect(directions).toContainText('忠孝新生站');
  await expect(directions).not.toContainText('忠孝復興站');
  await expect(directions).toContainText('Zhongxiao Xinsheng');
  await expect(directions).not.toContainText('Zhongxiao Fuxing');
});

test('3D initialization ignores a canvas detached while scene imports are pending', async ({ page }) => {
  test.setTimeout(45_000);
  let releaseScene;
  let sceneRequested;
  const sceneReady = new Promise((resolve) => { releaseScene = resolve; });
  const requestSeen = new Promise((resolve) => { sceneRequested = resolve; });
  await page.addInitScript(() => {
    window.__lineWebglCanvases = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (/^webgl/i.test(type)) window.__lineWebglCanvases.push(this);
      return getContext.call(this, type, ...args);
    };
  });
  await page.route('**/assets/js/factory-scene.js', async (route) => {
    sceneRequested();
    await sceneReady;
    await route.continue();
  });
  await waitForApp(page);
  await page.evaluate(() => { window.__staleLineCanvas = document.querySelector('#lineCanvas'); });
  await page.mouse.wheel(0, 500);
  await requestSeen;
  await page.locator('.desktop-nav .navlink').nth(1).click();
  await expect(page.locator('#lineCanvas')).toHaveCount(0);
  await page.locator('.desktop-nav .navlink').first().click();
  const currentCanvas = await page.locator('#lineCanvas').elementHandle();
  releaseScene();

  await expect.poll(async () => page.evaluate(() => window.__lineWebglCanvases.length > 0)).toBe(true);
  const attachedCanvasCount = await page.evaluate(() => new Set(window.__lineWebglCanvases.filter((canvas) => canvas.isConnected)).size);
  const staleCanvasUsed = await page.evaluate(() => window.__lineWebglCanvases.includes(window.__staleLineCanvas));
  expect(staleCanvasUsed).toBe(false);
  expect(attachedCanvasCount).toBe(1);
  expect(await currentCanvas.evaluate((canvas) => canvas.isConnected)).toBe(true);
});

test('3D import and renderer failures keep the static fallback visible', async ({ browser }) => {
  for (const failure of ['import', 'renderer']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (failure === 'renderer') {
      await page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (/^webgl/i.test(type)) throw new Error('controlled WebGL failure');
          return getContext.call(this, type, ...args);
        };
      });
    } else {
      await page.route('**/assets/js/factory-scene.js', (route) => route.fulfill({
        status: 503,
        contentType: 'text/javascript',
        body: 'throw new Error("controlled scene import failure");',
      }));
    }
    await waitForApp(page);
    await page.mouse.wheel(0, 500);
    await expect(page.locator('#lineFallback')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#lineFallback')).toHaveCSS('opacity', '1');
    await expect(page.locator('#lineFallback')).toContainText('3D MODEL UNAVAILABLE');
    await context.close();
  }
});

test('layout shift stays within the five second budget at required viewports and language switch', async ({ browser }) => {
  test.setTimeout(60_000);
  const viewports = [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ];
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const state = { startedAt: performance.now(), value: 0 };
      window.__labCls = state;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput && entry.startTime >= state.startedAt && entry.startTime <= state.startedAt + 5000) state.value += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/');
    await page.waitForFunction(() => window.React && window.ReactDOM && window.STORY_DATA);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
    await expect(page.locator('html')).toHaveAttribute('data-lang', 'zh');
    await expect(page.locator('.desktop-nav .navlink').first()).toHaveAttribute('data-on', '1');
    await page.waitForTimeout(5000);
    const zhCls = await page.evaluate(() => window.__labCls.value);
    await page.evaluate(() => {
      window.__labCls.startedAt = performance.now();
      window.__labCls.value = 0;
      document.querySelector('.desktop-nav .lang-toggle').click();
    });
    await page.waitForTimeout(5000);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('data-lang', 'en');
    await expect(page.locator('.desktop-nav .navlink').first()).toHaveAttribute('data-on', '1');
    const enCls = await page.evaluate(() => window.__labCls.value);
    expect(zhCls, `${viewport.width}x${viewport.height} zh CLS`).toBeLessThanOrEqual(0.1);
    expect(enCls, `${viewport.width}x${viewport.height} en CLS`).toBeLessThanOrEqual(0.1);
    await context.close();
  }
});
