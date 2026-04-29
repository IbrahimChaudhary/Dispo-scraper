import { defineConfig } from "playwright";

export default defineConfig({
  timeout: 120_000,
  use: {
    viewport: { width: 1600, height: 900 },
    ignoreHTTPSErrors: true
  }
});
