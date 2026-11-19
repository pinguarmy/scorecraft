import { test as base } from '@playwright/test';
import { randomUUID } from 'node:crypto';
export { expect } from '@playwright/test';
export type { Page, Locator } from '@playwright/test';

// A sample's persisted practice state must not leak between tests. The unique
// XML comment changes only document identity, not notes, timing or title.
export const test = base.extend<{ isolatedSampleDocuments: void }>({
  isolatedSampleDocuments: [async ({ page }, use) => {
    const identity = randomUUID();
    await page.route('**/samples/*.musicxml', async route => {
      const response = await route.fetch();
      const xml = (await response.text()).replace('<score-partwise', `<!--browser-test-${identity}--><score-partwise`);
      await route.fulfill({ response, body: xml });
    });
    await use();
  }, { auto: true }],
});
