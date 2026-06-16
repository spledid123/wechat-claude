/**
 * Quick check: Can we import and use @anthropic-ai/claude-agent-sdk?
 *
 * This script does a REAL call (not a mock). It verifies:
 * 1. The SDK package installed correctly
 * 2. The `query()` function is callable
 * 3. We get a response back (streaming)
 *
 * Requires ANTHROPIC_API_KEY or DEEPSEEK_API_KEY in environment.
 *
 * Usage: node scripts/check-claude-sdk.js
 */

async function main() {
  console.log("=== Claude Agent SDK Connectivity Check ===\n");

  // 1. Check environment
  const hasApiKey =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.ANTHROPIC_BASE_URL ||
    !!process.env.DEEPSEEK_API_KEY;

  if (!hasApiKey) {
    console.log("⚠️  No API key found in environment.");
    console.log("   Set ANTHROPIC_API_KEY or DEEPSEEK_API_KEY to run a live test.");
    console.log("   Will attempt import-only check (no API call).\n");
  }

  // 2. Try importing
  let sdk;
  try {
    sdk = await import("@anthropic-ai/claude-agent-sdk");
    console.log("✅ SDK package imported successfully");
    console.log(`   Exports: ${Object.keys(sdk).join(", ")}`);
    console.log(`   query is: ${typeof sdk.query}`);
  } catch (err) {
    console.error("❌ Failed to import @anthropic-ai/claude-agent-sdk");
    console.error(`   ${err.message}`);
    console.error("\n   Possible causes:");
    console.error("   - package not installed (run: npm install)");
    console.error("   - Node.js version too old (need >= 18)");
    process.exit(1);
  }

  // 3. If no key, skip live test
  if (!hasApiKey) {
    console.log("\n✅ Import check passed (skipped live API call — no key configured).");
    console.log("   To run a live test, set ANTHROPIC_API_KEY in your environment.");
    process.exit(0);
  }

  // 4. Live test
  console.log("\n📡 Running live query test...\n");

  try {
    const abortController = new AbortController();

    // Auto-abort after 30s
    const timer = setTimeout(() => {
      console.log("⏱️  Timeout (30s) — aborting");
      abortController.abort();
    }, 30_000);

    let resultText = "";
    let chunks = 0;

    for await (const msg of sdk.query({
      prompt: "Reply with exactly: 'SDK_OK'",
      options: {
        model: "sonnet",
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        abortController,
        env: process.env,
        settingSources: [],
      },
    })) {
      chunks++;
      if (msg.type === "result" && msg.result) {
        resultText = msg.result;
      } else if (msg.type === "assistant") {
        process.stdout.write(".");
      }
    }

    clearTimeout(timer);
    console.log("");

    if (resultText.includes("SDK_OK") || resultText.length > 0) {
      console.log("✅ Live query succeeded!");
      console.log(`   Response (${resultText.length} chars): ${resultText.slice(0, 200)}`);
      console.log(`   Stream chunks received: ${chunks}`);
    } else {
      console.log("⚠️  Query completed but no recognizable response.");
      console.log(`   Raw result: ${JSON.stringify(resultText)}`);
    }
  } catch (err) {
    console.error(`❌ Live query failed: ${err.message}`);
    process.exit(1);
  }
}

main();
