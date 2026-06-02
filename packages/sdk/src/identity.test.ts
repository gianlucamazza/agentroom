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

describe("configBase resolution order", () => {
  it("explicit home arg wins over everything", () => {
    process.env["AGENTROOM_HOME"] = "/env/home";
    process.env["HOME"] = "/user";
    expect(configBase("/explicit")).toBe("/explicit");
  });

  it("falls back to AGENTROOM_HOME when no arg is given", () => {
    process.env["AGENTROOM_HOME"] = "/env/home";
    process.env["HOME"] = "/user";
    expect(configBase()).toBe("/env/home");
  });

  it("falls back to ~/.config/agentroom when neither arg nor env is set", () => {
    delete process.env["AGENTROOM_HOME"];
    process.env["HOME"] = "/user";
    expect(configBase()).toBe(path.join("/user", ".config", "agentroom"));
  });

  it("derives identityPath and sessionsDir under the resolved base (env)", () => {
    process.env["AGENTROOM_HOME"] = "/env/home";
    expect(identityPath()).toBe(path.join("/env/home", "identity.json"));
    expect(sessionsDir()).toBe(path.join("/env/home", "sessions"));
  });

  it("an explicit arg still overrides the env for derived paths", () => {
    process.env["AGENTROOM_HOME"] = "/env/home";
    expect(identityPath("/explicit")).toBe(path.join("/explicit", "identity.json"));
  });
});
