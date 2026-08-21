import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const marketplacePath = path.join(
  repositoryRoot,
  ".agents",
  "plugins",
  "marketplace.json"
);

function requireObject(value, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function requireNonemptyString(value, description) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${description} must be a nonempty string`);
  }
  return value;
}

function requireOnlyFields(value, allowed, description) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`${description} contains unsupported field ${field}`);
    }
  }
}

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (cause) {
    throw new Error(`cannot read valid JSON from ${filename}: ${cause.message}`);
  }
}

const marketplace = requireObject(
  await readJson(marketplacePath),
  "marketplace"
);
requireNonemptyString(marketplace.name, "marketplace.name");
if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
  throw new Error("marketplace.plugins must contain at least one plugin");
}

for (const [index, rawPlugin] of marketplace.plugins.entries()) {
  const plugin = requireObject(rawPlugin, `marketplace.plugins[${index}]`);
  requireOnlyFields(
    plugin,
    new Set(["name", "source", "policy", "category"]),
    `marketplace.plugins[${index}]`
  );
  const pluginName = requireNonemptyString(
    plugin.name,
    `marketplace.plugins[${index}].name`
  );
  const source = requireObject(
    plugin.source,
    `marketplace.plugins[${index}].source`
  );
  if (source.source !== "local") {
    throw new Error(`${pluginName}: source.source must be local`);
  }
  const relativePluginPath = requireNonemptyString(
    source.path,
    `${pluginName}: source.path`
  );
  if (relativePluginPath !== `./plugins/${pluginName}`) {
    throw new Error(
      `${pluginName}: local source must be ./plugins/${pluginName}`
    );
  }
  const policy = requireObject(plugin.policy, `${pluginName}: policy`);
  if (!["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(
    policy.installation
  )) {
    throw new Error(`${pluginName}: invalid installation policy`);
  }
  if (!["ON_INSTALL", "ON_USE"].includes(policy.authentication)) {
    throw new Error(`${pluginName}: invalid authentication policy`);
  }
  requireNonemptyString(plugin.category, `${pluginName}: category`);
  // Codex resolves local sources from the selected marketplace root (the
  // repository root here), not from the nested marketplace.json directory.
  const pluginRoot = path.resolve(repositoryRoot, relativePluginPath);
  const relativeToRepository = path.relative(repositoryRoot, pluginRoot);
  if (relativeToRepository.startsWith("..") || path.isAbsolute(relativeToRepository)) {
    throw new Error(`${pluginName}: local source escapes the repository`);
  }

  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = requireObject(
    await readJson(manifestPath),
    `${pluginName} manifest`
  );
  if (manifest.name !== pluginName) {
    throw new Error(
      `${pluginName}: manifest name ${JSON.stringify(manifest.name)} does not match`
    );
  }
  for (const field of ["version", "description", "license"]) {
    requireNonemptyString(manifest[field], `${pluginName}: manifest.${field}`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`${pluginName}: manifest.version must be semantic versioning`);
  }

  if (manifest.skills !== "./skills/") {
    throw new Error(`${pluginName}: manifest.skills must be ./skills/`);
  }
  const skillsRoot = path.join(pluginRoot, "skills");
  const skillEntries = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  if (skillEntries.length === 0) {
    throw new Error(`${pluginName}: manifest must expose at least one skill`);
  }
  for (const entry of skillEntries) {
    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    const skill = await readFile(skillPath, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(skill);
    if (!frontmatter) {
      throw new Error(`${pluginName}: ${entry.name}/SKILL.md lacks frontmatter`);
    }
    if (!new RegExp(`^name: ${entry.name}$`, "m").test(frontmatter[1])) {
      throw new Error(`${pluginName}: skill name must match ${entry.name}`);
    }
    if (!/^description: \S.+$/m.test(frontmatter[1])) {
      throw new Error(`${pluginName}: ${entry.name} lacks a description`);
    }
    if (skill.includes("[TODO:")) {
      throw new Error(`${pluginName}: ${entry.name} contains a TODO placeholder`);
    }
  }

  const queryScript = path.join(
    skillsRoot,
    "titan-lsp-query",
    "scripts",
    "titan-lsp-query.mjs"
  );
  if (!(await stat(queryScript)).isFile()) {
    throw new Error(`${pluginName}: Titan LSP query script is missing`);
  }
}

console.log(
  `validated ${marketplace.plugins.length} plugin from ${path.relative(repositoryRoot, marketplacePath)}`
);
