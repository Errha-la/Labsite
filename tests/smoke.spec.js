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
    await page.waitForFunction(() => window.React && window.ReactDOM && window.STORY_DATA);
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
