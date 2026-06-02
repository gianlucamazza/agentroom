import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { assetForPlatform, detectCloudflared, CLOUDFLARED_VERSION } from "./cloudflared.js";

describe("assetForPlatform", () => {
  it("maps the common platforms to the right release asset", () => {
    expect(assetForPlatform("linux", "x64")?.asset).toBe("cloudflared-linux-amd64");
    expect(assetForPlatform("linux", "arm64")?.asset).toBe("cloudflared-linux-arm64");
    expect(assetForPlatform("darwin", "arm64")?.asset).toBe("cloudflared-darwin-arm64.tgz");
    expect(assetForPlatform("win32", "x64")?.asset).toBe("cloudflared-windows-amd64.exe");
  });

  it("flags macOS assets as tgz archives (need extraction)", () => {
    expect(assetForPlatform("darwin", "x64")?.archive).toBe("tgz");
    expect(assetForPlatform("linux", "x64")?.archive).toBeUndefined();
  });

  it("returns undefined for unsupported platform/arch", () => {
    expect(assetForPlatform("sunos", "sparc")).toBeUndefined();
    expect(assetForPlatform("linux", "mips")).toBeUndefined();
  });

  it("pins a 64-hex sha256 for every supported asset", () => {
    for (const [platform, arch] of [
      ["linux", "x64"], ["linux", "arm64"], ["linux", "arm"], ["linux", "ia32"],
      ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"], ["win32", "ia32"],
    ] as const) {
      const spec = assetForPlatform(platform, arch);
      expect(spec, `${platform}-${arch}`).toBeDefined();
      expect(spec!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("sha256 verification primitive", () => {
  it("computes a stable lowercase-hex digest (what the manager compares against)", () => {
    const digest = createHash("sha256").update(Buffer.from("agentroom")).digest("hex");
    expect(digest).toBe("b0fbf468b10fefa3933551baf1664071c61cf7b3a26e70cd7cebfd2e2d3aaebb");
  });
});

describe("detectCloudflared (env override)", () => {
  it("ignores a non-executable AGENTROOM_CLOUDFLARED and falls through", () => {
    const prev = process.env["AGENTROOM_CLOUDFLARED"];
    process.env["AGENTROOM_CLOUDFLARED"] = "/nonexistent/cloudflared-xyz";
    try {
      const info = detectCloudflared("/tmp/agentroom-test-home-does-not-exist");
      // No override (not executable), no cache in a bogus home; result is system PATH or null.
      expect(info === null || info.source === "system").toBe(true);
    } finally {
      if (prev === undefined) delete process.env["AGENTROOM_CLOUDFLARED"];
      else process.env["AGENTROOM_CLOUDFLARED"] = prev;
    }
  });
});

describe("pinned version", () => {
  it("is a CalVer-looking tag", () => {
    expect(CLOUDFLARED_VERSION).toMatch(/^\d{4}\.\d+\.\d+$/);
  });
});
