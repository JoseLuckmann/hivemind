/**
 * `hive catalog` — manage the machine-global catalog of reusable resources
 * (agents / skills / mcps). Authored once, summoned into workspaces on demand.
 * See docs/design/agent-catalog.md. Storage lives in hive-core (catalog.ts).
 */
import { defineCommand } from "citty";
import { spawn } from "node:child_process";
import {
  ResourceKindZ,
  createResource,
  listResources,
  removeResource,
  resolveResource,
  type ResourceKind,
} from "@hivemind/core";
import { err, ok } from "../format.js";

const listCatalogCmd = defineCommand({
  meta: { name: "list", description: "List all catalog resources" },
  args: { json: { type: "boolean", description: "Emit JSON" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const items = await listResources();
    return ok(ctx, items, () => {
      if (items.length === 0) return "catalog is empty — try `hive catalog new agent <name>`";
      const nameW = Math.max(...items.map((r) => r.name.length));
      return items
        .map((r) => {
          const tags = r.tags.length ? `  [${r.tags.join(",")}]` : "";
          return `${r.kind.padEnd(5)}  ${r.name.padEnd(nameW)}  ${r.title}${tags}`;
        })
        .join("\n");
    });
  },
});

function newKindCmd(kind: ResourceKind) {
  return defineCommand({
    meta: { name: kind, description: `Scaffold a new ${kind} resource` },
    args: {
      name: { type: "positional", description: "Resource name (kebab-case)", required: true },
      title: { type: "string", description: "Human title" },
      tags: { type: "string", description: "Comma-separated tags" },
      json: { type: "boolean", description: "Emit JSON" },
    },
    async run({ args }) {
      const ctx = { json: !!args.json };
      try {
        const r = await createResource({
          kind,
          name: String(args.name),
          title: args.title ? String(args.title) : undefined,
          tags: args.tags ? String(args.tags).split(",").map((s) => s.trim()).filter(Boolean) : [],
        });
        return ok(ctx, r, () =>
          [
            `✓ created ${r.kind}/${r.name}`,
            r.canonicalFile ? `  edit: hive catalog edit ${r.name}` : `  edit resource.yaml in ${r.dir}`,
          ].join("\n"),
        );
      } catch (e) {
        return err(ctx, (e as { code?: string }).code ?? "create_failed", (e as Error).message);
      }
    },
  });
}

const newCatalogCmd = defineCommand({
  meta: { name: "new", description: "Scaffold a new resource (agent / skill / mcp)" },
  subCommands: {
    agent: newKindCmd("agent"),
    skill: newKindCmd("skill"),
    mcp: newKindCmd("mcp"),
  },
});

const editCatalogCmd = defineCommand({
  meta: { name: "edit", description: "Open a resource's canonical file in $EDITOR" },
  args: {
    name: { type: "positional", description: "Resource name", required: true },
    json: { type: "boolean", description: "Emit JSON" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const r = await resolveResource(String(args.name));
      const target = r.canonicalFile ?? `${r.dir}/resource.yaml`;
      if (ctx.json) return ok(ctx, { path: target });
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const child = spawn(editor, [target], { stdio: "inherit" });
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
      return;
    } catch (e) {
      return err(ctx, (e as { code?: string }).code ?? "edit_failed", (e as Error).message);
    }
  },
});

const rmCatalogCmd = defineCommand({
  meta: { name: "rm", description: "Remove a resource from the catalog" },
  args: {
    name: { type: "positional", description: "Resource name", required: true },
    json: { type: "boolean", description: "Emit JSON" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const r = await resolveResource(String(args.name));
      await removeResource(r.kind, r.name);
      return ok(ctx, { removed: `${r.kind}/${r.name}` }, () => `✓ removed ${r.kind}/${r.name}`);
    } catch (e) {
      return err(ctx, (e as { code?: string }).code ?? "rm_failed", (e as Error).message);
    }
  },
});

export const catalogCmd = defineCommand({
  meta: {
    name: "catalog",
    description: "Manage the global catalog of agents / skills / mcps",
  },
  subCommands: {
    list: listCatalogCmd,
    new: newCatalogCmd,
    edit: editCatalogCmd,
    rm: rmCatalogCmd,
  },
});

// re-exported so ResourceKindZ options stay the single source of truth
void ResourceKindZ;
