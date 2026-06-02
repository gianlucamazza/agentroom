import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { configBase, identityPath, sessionsDir } from "./identity.js";

const ORIG_HOME = process.env["HOME"];
const ORIG_AGENTROOM_HOME = process.env["AGENTROOM_HOME"];

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIG_HOME;
  if (ORIG_AGENTROOM_HOME === undefined) delete process.env["AGENTROOM_HOME"];
  else process.env["AGENTROOM_HOME"] = ORIG_AGENTROOM_HOME;
});

describe("configBase (single identity)", () => {
  it("explicit home arg is honored (dev/test affordance)", () => {
    process.env["HOME"] = "/user";
    expect(configBase("/explicit")).toBe("/explicit");
  });

  it("defaults to ~/.config/agentroom when no arg is given", () => {
    process.env["HOME"] = "/user";
    expect(configBase()).toBe(path.join("/user", ".config", "agentroom"));
  });

  it("does NOT honor AGENTROOM_HOME — there is a single identity for now", () => {
    process.env["AGENTROOM_HOME"] = "/env/home";
    process.env["HOME"] = "/user";
    expect(configBase()).toBe(path.join("/user", ".config", "agentroom"));
  });

  it("derives identityPath and sessionsDir under the default base", () => {
    process.env["HOME"] = "/user";
    expect(identityPath()).toBe(path.join("/user", ".config", "agentroom", "identity.json"));
    expect(sessionsDir()).toBe(path.join("/user", ".config", "agentroom", "sessions"));
  });

  it("an explicit arg overrides the default for derived paths", () => {
    expect(identityPath("/explicit")).toBe(path.join("/explicit", "identity.json"));
  });
});
