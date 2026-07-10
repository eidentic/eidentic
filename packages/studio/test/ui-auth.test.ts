// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders } from "../ui/src/api.js";

describe("Studio UI credential handoff", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("does not consume a query-string credential by default and redacts it from the URL", () => {
    window.history.replaceState(null, "", "/studio?key=query-secret&tab=runs");
    expect(authHeaders()).toEqual({});
    expect(window.location.search).toBe("?tab=runs");
    expect(sessionStorage.length).toBe(0);
  });

  it("consumes a fragment credential into session-scoped storage and removes it from the URL", () => {
    window.history.replaceState(null, "", "/studio?tab=runs#key=fragment-secret&session=s1");
    expect(authHeaders()).toEqual({ Authorization: "Bearer fragment-secret" });
    expect(window.location.hash).toBe("#session=s1");
    expect(window.location.search).toBe("?tab=runs");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.getItem("eidentic_studio_key")).toBe("fragment-secret");
  });

  it("supports legacy query credentials only through an explicit opt-in", () => {
    window.history.replaceState(null, "", "/studio?key=legacy-query-secret");
    expect(authHeaders({ allowQueryCredential: true })).toEqual({
      Authorization: "Bearer legacy-query-secret",
    });
    expect(window.location.search).toBe("");
  });
});
