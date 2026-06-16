import { defineConfig } from "vitest/config";
import path from "node:path";

const MOCK_SDK = path.resolve("test", "__mocks__", "claude-agent-sdk.ts");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 15_000,
    resolve: {
      alias: {
        // Route ALL imports of the SDK to our mock during tests.
        // This catches both static `import { query } from "..."` and
        // dynamic `await import("...")` calls inside ClaudeSession.
        "@anthropic-ai/claude-agent-sdk": MOCK_SDK,
      },
    },
  },
});
