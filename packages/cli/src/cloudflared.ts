import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { configBase } from "@agentroom/sdk";

/**
 * agentroom manages its own `cloudflared` so `relay --tunnel` needs no
 * system-installed, hand-configured binary. The pinned version is downloaded
 * on-demand from Cloudflare's official GitHub releases, verified against a
 * pinned sha256, and cached under `<configBase>/bin/`. cloudflared is
 * Apache-2.0 (download/use permitted); we don't redistribute it.
 *
 * Bump procedure (keep VERSION + ASSETS in sync):
 *   gh release view --repo cloudflare/cloudflared --json tagName,assets \
 *     -q '.assets[] | "\(.name) \(.digest)"'
 */
export const CLOUDFLARED_VERSION = "2026.5.2";

interface AssetSpec {
  asset: string;
  sha256: string;
  archive?: "tgz";
}

// Keyed by `${process.platform}-${process.arch}`. sha256 is the GitHub asset
// digest for CLOUDFLARED_VERSION (of the downloaded file, i.e. the .tgz on macOS).
const ASSETS: Record<string, AssetSpec> = {
  "linux-x64": { asset: "cloudflared-linux-amd64", sha256: "5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886" },
  "linux-arm64": { asset: "cloudflared-linux-arm64", sha256: "5a4e8ce2701105271412059f44b6a0bf1ae4542b4d98ff3180c0c019443a5815" },
  "linux-arm": { asset: "cloudflared-linux-arm", sha256: "70a4c869a037bd69af6ce2ad0c4da4a7680d94fcfb8d4c70ecddae24d560762f" },
  "linux-ia32": { asset: "cloudflared-linux-386", sha256: "ad82d1dbed8bbb9d702807cbd97df932cc774d29e9da5c109b7a3c7f7aee2065" },
  "darwin-x64": { asset: "cloudflared-darwin-amd64.tgz", sha256: "7240f709506bc2c1eb9da4d89cf2555499c60280ecb854b7d80e8f17d4b7903d", archive: "tgz" },
  "darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", sha256: "ba94054c9fd4297645093d59d51442e5e546d07bb0516120e694a13d5b216d38", archive: "tgz" },
  "win32-x64": { asset: "cloudflared-windows-amd64.exe", sha256: "20b9638f685333d623798e733effbad2487093f15ba592f6c7752360ff3b7ab7" },
  "win32-ia32": { asset: "cloudflared-windows-386.exe", sha256: "6736615e8d2b3b61e868e32907e85641b4ec7b2b8c26bd3361ec15e56e53e242" },
};

export type CloudflaredSource = "env" | "cache" | "downloaded" | "system";

export interface EnsureOpts {
  emit?: (o: Record<string, unknown>) => void;
  human?: (s: string) => void;
  home?: string;
}

export interface CloudflaredInfo {
  path: string;
  source: CloudflaredSource;
  version?: string;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function cachePath(home?: string): string {
  return path.join(configBase(home), "bin", binaryName());
}

/** Parse `cloudflared version <X> (built …)`; undefined if it won't run. */
function versionOf(bin: string): string | undefined {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const m = `${r.stdout}${r.stderr}`.match(/cloudflared version (\S+)/);
  return m?.[1];
}

function systemCloudflared(): string | undefined {
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, ["cloudflared"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  return undefined;
}

async function download(spec: AssetSpec, binDir: string, finalPath: string): Promise<void> {
  mkdirSync(binDir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${spec.asset}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${spec.asset}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== spec.sha256) {
    throw new Error(`sha256 mismatch for ${spec.asset}: expected ${spec.sha256}, got ${digest}`);
  }

  const tmp = path.join(binDir, `.dl.${process.pid}.${spec.asset}`);
  writeFileSync(tmp, buf);
  const installRaw = () => {
    chmodSync(tmp, 0o755);
    if (process.platform === "win32" && existsSync(finalPath)) rmSync(finalPath, { force: true });
    renameSync(tmp, finalPath);
  };

  try {
    if (spec.archive === "tgz") {
      const extractDir = path.join(binDir, `.extract.${process.pid}`);
      mkdirSync(extractDir, { recursive: true });
      try {
        const r = spawnSync("tar", ["-xzf", tmp, "-C", extractDir], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`tar extraction failed: ${r.stderr || r.status}`);
        const extracted = path.join(extractDir, "cloudflared");
        if (!existsSync(extracted)) throw new Error("cloudflared not found in archive");
        chmodSync(extracted, 0o755);
        if (existsSync(finalPath)) rmSync(finalPath, { force: true });
        renameSync(extracted, finalPath);
      } finally {
        rmSync(extractDir, { recursive: true, force: true });
      }
    } else {
      installRaw();
    }
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

/**
 * Resolve a usable cloudflared without requiring a system install:
 *   1. $AGENTROOM_CLOUDFLARED (explicit path)
 *   2. pinned binary cached under <configBase>/bin
 *   3. download the pinned version (sha256-verified) into the cache
 *   4. fall back to a system PATH cloudflared if the download fails (offline)
 * Throws only if every avenue is exhausted.
 */
export async function ensureCloudflared(opts: EnsureOpts = {}): Promise<CloudflaredInfo> {
  const { emit, human, home } = opts;
  const note = (state: string, extra: Record<string, unknown> = {}) =>
    emit?.({ type: "cloudflared", state, ...extra });

  const override = process.env["AGENTROOM_CLOUDFLARED"];
  if (override) {
    if (isExecutable(override)) {
      note("env", { path: override });
      return { path: override, source: "env", version: versionOf(override) };
    }
    throw new Error(`AGENTROOM_CLOUDFLARED=${override} is not an executable file`);
  }

  const key = `${process.platform}-${process.arch}`;
  const spec = ASSETS[key];
  const cached = cachePath(home);

  if (spec && existsSync(cached) && versionOf(cached) === CLOUDFLARED_VERSION) {
    note("cached", { path: cached, version: CLOUDFLARED_VERSION });
    return { path: cached, source: "cache", version: CLOUDFLARED_VERSION };
  }

  if (spec) {
    try {
      note("downloading", { version: CLOUDFLARED_VERSION, asset: spec.asset });
      human?.(`downloading cloudflared ${CLOUDFLARED_VERSION} (${spec.asset})…`);
      await download(spec, path.dirname(cached), cached);
      note("ready", { path: cached, version: CLOUDFLARED_VERSION });
      return { path: cached, source: "downloaded", version: CLOUDFLARED_VERSION };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      note("download_failed", { error: msg });
      human?.(`cloudflared download failed (${msg}) — trying system PATH`);
    }
  } else {
    note("unsupported_platform", { platform: key });
  }

  const sys = systemCloudflared();
  if (sys) {
    note("fallback_path", { path: sys });
    return { path: sys, source: "system", version: versionOf(sys) };
  }

  throw new Error(
    spec
      ? "could not download cloudflared and none found on PATH (offline?) — install it or set AGENTROOM_CLOUDFLARED"
      : `no prebuilt cloudflared for ${key} — install it manually and set AGENTROOM_CLOUDFLARED or put it on PATH`,
  );
}

/**
 * Non-downloading probe for `setup` reporting: returns what cloudflared would be
 * used today (env override → pinned cache → system PATH), or null if none.
 */
export function detectCloudflared(home?: string): CloudflaredInfo | null {
  const override = process.env["AGENTROOM_CLOUDFLARED"];
  if (override && isExecutable(override)) {
    return { path: override, source: "env", version: versionOf(override) };
  }
  const cached = cachePath(home);
  if (existsSync(cached)) {
    const v = versionOf(cached);
    if (v) return { path: cached, source: "cache", version: v };
  }
  const sys = systemCloudflared();
  if (sys) return { path: sys, source: "system", version: versionOf(sys) };
  return null;
}

// Exposed for tests: platform→asset mapping is the part most likely to break.
export function assetForPlatform(platform: string, arch: string): AssetSpec | undefined {
  return ASSETS[`${platform}-${arch}`];
}
