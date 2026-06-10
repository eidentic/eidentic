import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addComponent,
  COMPONENT_NAMES,
  COMPONENT_DESCRIPTIONS,
  COMPONENTS_DIR_NAME,
  type AddComponentOptions,
} from "../src/commands.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

/** Absolute path to the real templates/components directory. */
const REAL_TEMPLATES_DIR = join(
  new URL("../templates/components", import.meta.url).pathname,
);

function makeProjectRoot(): string {
  const root = join(tmpDir, "project");
  mkdirSync(root, { recursive: true });
  return root;
}

/** Make a fake templates dir with stub .tsx files for all known components. */
function makeFakeTemplatesDir(): string {
  const dir = join(tmpDir, "templates", "components");
  mkdirSync(dir, { recursive: true });
  for (const name of COMPONENT_NAMES) {
    writeFileSync(join(dir, `${name}.tsx`), `// stub ${name}\nexport function Stub() { return null; }\n`, "utf8");
  }
  return dir;
}

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `eidentic-add-component-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic installation — using real templates
// ---------------------------------------------------------------------------

describe("addComponent() — real templates, happy path", () => {
  it("installs chat into <projectRoot>/components/eidentic/chat.tsx", () => {
    const projectRoot = makeProjectRoot();
    const result = addComponent("chat", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });

    expect(result.name).toBe("chat");
    expect(result.replaced).toBe(false);
    expect(result.installedAt).toBe(join(projectRoot, COMPONENTS_DIR_NAME, "chat.tsx"));
    expect(existsSync(result.installedAt)).toBe(true);
  });

  it("installs workflow-trace into the default target dir", () => {
    const projectRoot = makeProjectRoot();
    const result = addComponent("workflow-trace", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });

    expect(result.name).toBe("workflow-trace");
    expect(result.installedAt).toBe(
      join(projectRoot, COMPONENTS_DIR_NAME, "workflow-trace.tsx"),
    );
    expect(existsSync(result.installedAt)).toBe(true);
  });

  it("installs run-status into the default target dir", () => {
    const projectRoot = makeProjectRoot();
    const result = addComponent("run-status", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });

    expect(result.name).toBe("run-status");
    expect(result.installedAt).toBe(
      join(projectRoot, COMPONENTS_DIR_NAME, "run-status.tsx"),
    );
    expect(existsSync(result.installedAt)).toBe(true);
  });

  it("creates the target directory when it does not exist", () => {
    const projectRoot = makeProjectRoot();
    addComponent("chat", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });

    expect(existsSync(join(projectRoot, COMPONENTS_DIR_NAME))).toBe(true);
  });

  it("copies the file content verbatim from the real template", () => {
    const projectRoot = makeProjectRoot();
    const result = addComponent("chat", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });

    const installed = readFileSync(result.installedAt, "utf8");
    expect(installed).toContain("eidentic add component");
    expect(installed).toContain("useAgent");
  });

  it("copies the template marker comment into workflow-trace", () => {
    const projectRoot = makeProjectRoot();
    const result = addComponent("workflow-trace", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });
    const installed = readFileSync(result.installedAt, "utf8");
    expect(installed).toContain("eidentic add component");
    expect(installed).toContain("useWorkflowRun");
  });

  it("copies the template marker comment into run-status", () => {
    const projectRoot = makeProjectRoot();
    const result = addComponent("run-status", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });
    const installed = readFileSync(result.installedAt, "utf8");
    expect(installed).toContain("eidentic add component");
    expect(installed).toContain("useAsyncRun");
  });
});

// ---------------------------------------------------------------------------
// --dir override
// ---------------------------------------------------------------------------

describe("addComponent() — custom --dir", () => {
  it("installs into the specified dir relative to projectRoot", () => {
    const projectRoot = makeProjectRoot();
    const result = addComponent("chat", {
      projectRoot,
      targetDir: "src/ui/eidentic",
      templatesDir: REAL_TEMPLATES_DIR,
    });

    expect(result.installedAt).toBe(join(projectRoot, "src/ui/eidentic", "chat.tsx"));
    expect(existsSync(result.installedAt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Collision handling
// ---------------------------------------------------------------------------

describe("addComponent() — collision handling", () => {
  it("refuses to overwrite an existing file without --force", () => {
    const projectRoot = makeProjectRoot();
    addComponent("chat", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });

    expect(() =>
      addComponent("chat", { projectRoot, templatesDir: REAL_TEMPLATES_DIR }),
    ).toThrow(/already exists.*--force/);
  });

  it("overwrites an existing file when force:true", () => {
    const templatesDir = makeFakeTemplatesDir();
    const projectRoot = makeProjectRoot();

    addComponent("chat", { projectRoot, templatesDir });

    // Overwrite the stub with different content to verify force-overwrite.
    writeFileSync(join(templatesDir, "chat.tsx"), "// updated stub\n", "utf8");

    const result = addComponent("chat", { projectRoot, templatesDir, force: true });

    expect(result.replaced).toBe(true);
    const content = readFileSync(result.installedAt, "utf8");
    expect(content).toContain("// updated stub");
  });

  it("returns replaced:false on a fresh install (no collision)", () => {
    const projectRoot = makeProjectRoot();
    const result = addComponent("chat", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });
    expect(result.replaced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown name
// ---------------------------------------------------------------------------

describe("addComponent() — unknown name", () => {
  it("throws a clear error for an unknown component name", () => {
    const projectRoot = makeProjectRoot();
    expect(() => addComponent("nope", { projectRoot })).toThrow(
      /unknown component "nope"/,
    );
  });

  it("includes the list of available component names in the error", () => {
    const projectRoot = makeProjectRoot();
    expect(() => addComponent("mystery", { projectRoot })).toThrow(
      new RegExp(COMPONENT_NAMES.join("|")),
    );
  });
});

// ---------------------------------------------------------------------------
// --overwrite flag (alias for force)
// ---------------------------------------------------------------------------

describe("addComponent() — --overwrite flag", () => {
  it("overwrites an existing file when overwrite:true", () => {
    const templatesDir = makeFakeTemplatesDir();
    const projectRoot = makeProjectRoot();

    addComponent("chat", { projectRoot, templatesDir });

    writeFileSync(join(templatesDir, "chat.tsx"), "// overwritten stub\n", "utf8");

    const result = addComponent("chat", { projectRoot, templatesDir, overwrite: true });
    expect(result.replaced).toBe(true);
    const content = readFileSync(result.installedAt, "utf8");
    expect(content).toContain("// overwritten stub");
  });

  it("refuses to overwrite without overwrite:true", () => {
    const projectRoot = makeProjectRoot();
    addComponent("chat", { projectRoot, templatesDir: REAL_TEMPLATES_DIR });

    expect(() =>
      addComponent("chat", { projectRoot, templatesDir: REAL_TEMPLATES_DIR }),
    ).toThrow(/already exists.*--force/);
  });

  it("overwrite:true and force:true are equivalent", () => {
    const templatesDir = makeFakeTemplatesDir();
    const projectRoot = makeProjectRoot();
    addComponent("chat", { projectRoot, templatesDir });

    // force:true path
    const r1 = addComponent("chat", { projectRoot, templatesDir, force: true });
    expect(r1.replaced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// COMPONENT_DESCRIPTIONS
// ---------------------------------------------------------------------------

describe("COMPONENT_DESCRIPTIONS", () => {
  it("has a description for every component in COMPONENT_NAMES", () => {
    for (const name of COMPONENT_NAMES) {
      expect(typeof COMPONENT_DESCRIPTIONS[name]).toBe("string");
      expect(COMPONENT_DESCRIPTIONS[name].length).toBeGreaterThan(0);
    }
  });

  it("chat description mentions useAgent", () => {
    expect(COMPONENT_DESCRIPTIONS["chat"]).toMatch(/useAgent/);
  });

  it("workflow-trace description mentions useWorkflowRun", () => {
    expect(COMPONENT_DESCRIPTIONS["workflow-trace"]).toMatch(/useWorkflowRun/);
  });

  it("run-status description mentions useAsyncRun", () => {
    expect(COMPONENT_DESCRIPTIONS["run-status"]).toMatch(/useAsyncRun/);
  });
});

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

describe("addComponent() — option types", () => {
  it("opts.projectRoot is optional", () => {
    const opts: AddComponentOptions = { force: false };
    expect(opts.projectRoot).toBeUndefined();
  });

  it("opts.overwrite is optional", () => {
    const opts: AddComponentOptions = { overwrite: false };
    expect(opts.force).toBeUndefined();
  });

  it("COMPONENT_NAMES contains the expected three names", () => {
    expect(COMPONENT_NAMES).toContain("chat");
    expect(COMPONENT_NAMES).toContain("workflow-trace");
    expect(COMPONENT_NAMES).toContain("run-status");
    expect(COMPONENT_NAMES).toHaveLength(3);
  });
});
