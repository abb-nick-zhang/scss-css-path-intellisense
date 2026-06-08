import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Logger } from "./logger";
import type { PathToken } from "./styleParser";
import type { ResolvedTsConfig, TsConfigService } from "./tsConfigService";

const STYLE_EXTENSIONS = [".scss", ".sass", ".css"];
const INDEX_FILES = ["index.scss", "index.sass", "index.css", "_index.scss", "_index.sass"];

interface ResolverOptions {
  enableNodeModules: boolean;
  enableUrl: boolean;
}

interface CompletionOptions {
  preferExtensionless: boolean;
  showPartialFiles: boolean;
  maxEntries: number;
}

interface CompletionPathParts {
  directoryPart: string;
  leafPrefix: string;
}

interface CachedDirectoryEntries {
  mtimeMs: number;
  entries: fs.Dirent[];
}

export interface CompletionCandidate {
  label: string;
  insertText: string;
  detail: string;
  isDirectory: boolean;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function stripQueryAndHash(specifier: string): string {
  return specifier.split(/[?#]/, 1)[0];
}

function shouldSkipPath(specifier: string): boolean {
  if (!specifier) {
    return true;
  }

  if (/^(?:data:|https?:|file:|mailto:|tel:|#|\/\/)/i.test(specifier)) {
    return true;
  }

  return false;
}

function hasExtension(specifier: string): boolean {
  return path.extname(specifier) !== "";
}

function isStyleFileName(fileName: string): boolean {
  return STYLE_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

function parseCompletionPathParts(rawPath: string): CompletionPathParts {
  const normalized = normalizeSlashes(stripQueryAndHash(rawPath));
  if (!normalized) {
    return { directoryPart: "", leafPrefix: "" };
  }

  if (normalized.endsWith("/")) {
    return {
      directoryPart: normalized,
      leafPrefix: ""
    };
  }

  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex < 0) {
    return {
      directoryPart: "",
      leafPrefix: normalized
    };
  }

  return {
    directoryPart: normalized.slice(0, slashIndex + 1),
    leafPrefix: normalized.slice(slashIndex + 1)
  };
}

function buildCandidateList(basePath: string): string[] {
  const cleaned = stripQueryAndHash(basePath);
  const candidates: string[] = [];
  const ext = path.extname(cleaned);

  if (ext) {
    candidates.push(cleaned);

    if (STYLE_EXTENSIONS.includes(ext)) {
      const dirname = path.dirname(cleaned);
      const filename = path.basename(cleaned);
      if (!filename.startsWith("_")) {
        candidates.push(path.join(dirname, `_${filename}`));
      }
    }
  } else {
    candidates.push(cleaned);

    for (const styleExt of STYLE_EXTENSIONS) {
      candidates.push(`${cleaned}${styleExt}`);
    }

    const dirname = path.dirname(cleaned);
    const basename = path.basename(cleaned);
    if (basename) {
      candidates.push(
        path.join(dirname, `_${basename}.scss`),
        path.join(dirname, `_${basename}.sass`)
      );
    }
  }

  for (const indexFile of INDEX_FILES) {
    candidates.push(path.join(cleaned, indexFile));
  }

  return candidates;
}

function resolveFirstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function parsePackageSpecifier(specifier: string): { packageName: string; subPath: string } {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2) {
      return { packageName: specifier, subPath: "" };
    }

    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subPath: parts.slice(2).join("/")
    };
  }

  const parts = specifier.split("/");
  return {
    packageName: parts[0],
    subPath: parts.slice(1).join("/")
  };
}

function pickExportTarget(exportsEntry: unknown): string | undefined {
  if (typeof exportsEntry === "string") {
    return exportsEntry;
  }

  if (Array.isArray(exportsEntry)) {
    for (const item of exportsEntry) {
      const target = pickExportTarget(item);
      if (target) {
        return target;
      }
    }

    return undefined;
  }

  if (!exportsEntry || typeof exportsEntry !== "object") {
    return undefined;
  }

  const conditionObject = exportsEntry as Record<string, unknown>;
  const preferredOrder = ["sass", "style", "development", "import", "require", "default"];

  for (const key of preferredOrder) {
    if (!(key in conditionObject)) {
      continue;
    }

    const target = pickExportTarget(conditionObject[key]);
    if (target) {
      return target;
    }
  }

  for (const key of Object.keys(conditionObject)) {
    const target = pickExportTarget(conditionObject[key]);
    if (target) {
      return target;
    }
  }

  return undefined;
}

function resolveViaPackageExports(
  specifier: string,
  sourceDir: string,
  logger: Logger
): string | undefined {
  const { packageName, subPath } = parsePackageSpecifier(specifier);

  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [sourceDir] });
  } catch {
    return undefined;
  }

  const packageDir = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
    style?: string;
  };

  if (subPath && packageJson.exports) {
    const exportKeys = [`./${subPath}`, `./${subPath}.scss`, `./${subPath}.sass`, `./${subPath}.css`];
    for (const exportKey of exportKeys) {
      const entry = packageJson.exports[exportKey];
      if (!entry) {
        continue;
      }

      const exportTarget = pickExportTarget(entry);
      if (!exportTarget) {
        continue;
      }

      const candidate = path.resolve(packageDir, exportTarget);
      const hit = resolveFirstExisting(buildCandidateList(candidate));
      if (hit) {
        return hit;
      }
    }
  }

  if (!subPath && packageJson.style) {
    const styleEntryPath = path.resolve(packageDir, packageJson.style);
    const styleHit = resolveFirstExisting(buildCandidateList(styleEntryPath));
    if (styleHit) {
      return styleHit;
    }
  }

  if (subPath) {
    const directSubPath = path.resolve(packageDir, subPath);
    const directHit = resolveFirstExisting(buildCandidateList(directSubPath));
    if (directHit) {
      return directHit;
    }
  }

  logger.debug(`Package export resolution failed for '${specifier}'`);
  return undefined;
}

function resolveViaRequire(specifier: string, sourceDir: string): string | undefined {
  try {
    return require.resolve(specifier, { paths: [sourceDir] });
  } catch {
    return undefined;
  }
}

function expandTsPathCandidates(specifier: string, tsConfig: ResolvedTsConfig): string[] {
  const candidates: string[] = [];
  const baseAbs = tsConfig.baseUrlAbs;

  const mappings = Object.entries(tsConfig.paths).sort((a, b) => b[0].length - a[0].length);

  for (const [aliasPattern, targetPatterns] of mappings) {
    if (!targetPatterns.length) {
      continue;
    }

    const wildcardIndex = aliasPattern.indexOf("*");
    if (wildcardIndex < 0) {
      if (specifier !== aliasPattern) {
        continue;
      }

      for (const targetPattern of targetPatterns) {
        const normalizedTarget = normalizeSlashes(targetPattern);
        candidates.push(path.resolve(baseAbs, normalizedTarget));
      }

      continue;
    }

    const prefix = aliasPattern.slice(0, wildcardIndex);
    const suffix = aliasPattern.slice(wildcardIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
      continue;
    }

    const wildcardValue = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const targetPattern of targetPatterns) {
      const normalizedTarget = normalizeSlashes(targetPattern);
      const replaced = normalizedTarget.replace("*", wildcardValue);
      candidates.push(path.resolve(baseAbs, replaced));
    }
  }

  return candidates;
}

export class StylePathResolver {
  private readonly directoryCache = new Map<string, CachedDirectoryEntries>();

  public constructor(
    private readonly tsConfigService: TsConfigService,
    private readonly logger: Logger
  ) {}

  private getDirectoryEntries(dirPath: string): fs.Dirent[] {
    if (!isDirectory(dirPath)) {
      return [];
    }

    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(dirPath).mtimeMs;
    } catch {
      return [];
    }

    const cacheHit = this.directoryCache.get(dirPath);
    if (cacheHit?.mtimeMs === mtimeMs) {
      return cacheHit.entries;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    this.directoryCache.set(dirPath, {
      mtimeMs,
      entries
    });

    return entries;
  }

  private toFileInsertName(fileName: string, preferExtensionless: boolean): string {
    if (!preferExtensionless) {
      return fileName;
    }

    const ext = path.extname(fileName).toLowerCase();
    if (!STYLE_EXTENSIONS.includes(ext)) {
      return fileName;
    }

    let baseName = fileName.slice(0, fileName.length - ext.length);
    if (baseName.startsWith("_")) {
      baseName = baseName.slice(1);
    }

    return baseName || fileName;
  }

  private collectDirectoryCompletions(
    absoluteDirectory: string,
    insertionBase: string,
    leafPrefix: string,
    options: CompletionOptions,
    sink: Map<string, { candidate: CompletionCandidate; priority: number }>
  ): void {
    const entries = this.getDirectoryEntries(absoluteDirectory);
    if (!entries.length) {
      return;
    }

    const prefixLower = leafPrefix.toLowerCase();

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const directoryName = entry.name;
        if (!directoryName.toLowerCase().startsWith(prefixLower)) {
          continue;
        }

        const candidate: CompletionCandidate = {
          label: `${directoryName}/`,
          insertText: `${insertionBase}${directoryName}/`,
          detail: normalizeSlashes(path.join(absoluteDirectory, directoryName)),
          isDirectory: true
        };

        const key = `dir:${candidate.insertText}`;
        sink.set(key, {
          candidate,
          priority: 30
        });
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileName = entry.name;
      if (!isStyleFileName(fileName)) {
        continue;
      }

      const isPartial = fileName.startsWith("_");
      if (isPartial && !options.showPartialFiles) {
        continue;
      }

      const insertName = this.toFileInsertName(fileName, options.preferExtensionless);
      const fileNameLower = fileName.toLowerCase();
      const insertNameLower = insertName.toLowerCase();
      if (!fileNameLower.startsWith(prefixLower) && !insertNameLower.startsWith(prefixLower)) {
        continue;
      }

      const candidate: CompletionCandidate = {
        label: fileName,
        insertText: `${insertionBase}${insertName}`,
        detail: normalizeSlashes(path.join(absoluteDirectory, fileName)),
        isDirectory: false
      };

      const key = `file:${candidate.insertText}`;
      const priority = isPartial ? 10 : 20;
      const existing = sink.get(key);
      if (!existing || priority > existing.priority) {
        sink.set(key, {
          candidate,
          priority
        });
      }
    }
  }

  private collectAliasPrefixCompletions(
    tsConfig: ResolvedTsConfig,
    leafPrefix: string,
    sink: Map<string, { candidate: CompletionCandidate; priority: number }>
  ): void {
    const prefixLower = leafPrefix.toLowerCase();

    for (const aliasPattern of Object.keys(tsConfig.paths)) {
      const wildcardIndex = aliasPattern.indexOf("*");
      const aliasPrefix = wildcardIndex >= 0 ? aliasPattern.slice(0, wildcardIndex) : aliasPattern;
      if (!aliasPrefix) {
        continue;
      }

      if (!aliasPrefix.toLowerCase().startsWith(prefixLower)) {
        continue;
      }

      const isDirectoryLike = aliasPrefix.endsWith("/");
      const candidate: CompletionCandidate = {
        label: isDirectoryLike ? aliasPrefix : `${aliasPrefix}/`,
        insertText: isDirectoryLike ? aliasPrefix : `${aliasPrefix}/`,
        detail: `Alias pattern: ${aliasPattern}`,
        isDirectory: true
      };

      const key = `alias:${candidate.insertText}`;
      sink.set(key, {
        candidate,
        priority: 40
      });
    }
  }

  public getCompletionCandidates(document: vscode.TextDocument, rawPath: string): CompletionCandidate[] {
    const config = vscode.workspace.getConfiguration("scssPathJump", document.uri);
    const options: CompletionOptions = {
      preferExtensionless: config.get<boolean>("preferExtensionless", true),
      showPartialFiles: config.get<boolean>("showPartialFiles", true),
      maxEntries: Math.max(20, config.get<number>("completionMaxEntries", 200))
    };

    const normalizedRawPath = normalizeSlashes(stripQueryAndHash(rawPath.trim()));
    if (normalizedRawPath && shouldSkipPath(normalizedRawPath)) {
      return [];
    }

    const pathParts = parseCompletionPathParts(normalizedRawPath);
    const candidates = new Map<string, { candidate: CompletionCandidate; priority: number }>();
    const sourceDir = path.dirname(document.uri.fsPath);

    if (normalizedRawPath.startsWith(".")) {
      const absoluteDirectory = path.resolve(sourceDir, pathParts.directoryPart || ".");
      this.collectDirectoryCompletions(
        absoluteDirectory,
        pathParts.directoryPart,
        pathParts.leafPrefix,
        options,
        candidates
      );
    } else if (normalizedRawPath.startsWith("/")) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (workspaceFolder) {
        const relativeDirectory = pathParts.directoryPart.startsWith("/")
          ? pathParts.directoryPart.slice(1)
          : pathParts.directoryPart;
        const absoluteDirectory = path.join(workspaceFolder.uri.fsPath, relativeDirectory);

        this.collectDirectoryCompletions(
          absoluteDirectory,
          pathParts.directoryPart,
          pathParts.leafPrefix,
          options,
          candidates
        );
      }
    } else {
      const tsConfig = this.tsConfigService.getForDocument(document.uri);
      if (tsConfig) {
        if (!pathParts.directoryPart) {
          this.collectAliasPrefixCompletions(tsConfig, pathParts.leafPrefix, candidates);
        }

        const aliasScanRoots = expandTsPathCandidates(pathParts.directoryPart, tsConfig);
        for (const scanRoot of aliasScanRoots) {
          this.collectDirectoryCompletions(
            scanRoot,
            pathParts.directoryPart,
            pathParts.leafPrefix,
            options,
            candidates
          );
        }

        const baseUrlDirectory = path.resolve(tsConfig.baseUrlAbs, pathParts.directoryPart || ".");
        this.collectDirectoryCompletions(
          baseUrlDirectory,
          pathParts.directoryPart,
          pathParts.leafPrefix,
          options,
          candidates
        );
      }

      if (!normalizedRawPath.startsWith("@")) {
        const implicitDirectory = path.resolve(sourceDir, pathParts.directoryPart || ".");
        this.collectDirectoryCompletions(
          implicitDirectory,
          pathParts.directoryPart,
          pathParts.leafPrefix,
          options,
          candidates
        );
      }
    }

    return Array.from(candidates.values())
      .map((entry) => entry.candidate)
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }

        return left.insertText.localeCompare(right.insertText);
      })
      .slice(0, options.maxEntries);
  }

  public clearCache(): void {
    this.directoryCache.clear();
  }

  public resolvePath(document: vscode.TextDocument, token: PathToken): vscode.Uri | undefined {
    const config = vscode.workspace.getConfiguration("scssPathJump", document.uri);
    const options: ResolverOptions = {
      enableNodeModules: config.get<boolean>("enableNodeModules", true),
      enableUrl: config.get<boolean>("enableUrl", true)
    };

    if (token.kind === "url" && !options.enableUrl) {
      return undefined;
    }

    const rawPath = token.rawPath.trim();
    if (shouldSkipPath(rawPath)) {
      return undefined;
    }

    const sourceDir = path.dirname(document.uri.fsPath);

    if (rawPath.startsWith(".")) {
      const relativeBase = path.resolve(sourceDir, normalizeSlashes(rawPath));
      const hit = resolveFirstExisting(buildCandidateList(relativeBase));
      if (hit) {
        return vscode.Uri.file(hit);
      }
    }

    if (rawPath.startsWith("/")) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (workspaceFolder) {
        const workspaceBase = path.join(workspaceFolder.uri.fsPath, rawPath.slice(1));
        const hit = resolveFirstExisting(buildCandidateList(workspaceBase));
        if (hit) {
          return vscode.Uri.file(hit);
        }
      }
    }

    const tsConfig = this.tsConfigService.getForDocument(document.uri);
    if (tsConfig) {
      const tsCandidates = expandTsPathCandidates(rawPath, tsConfig);
      for (const candidateBase of tsCandidates) {
        const hit = resolveFirstExisting(buildCandidateList(candidateBase));
        if (hit) {
          return vscode.Uri.file(hit);
        }
      }

      // Support bare paths resolved from tsconfig baseUrl when no alias key matches.
      const baseUrlHit = resolveFirstExisting(
        buildCandidateList(path.resolve(tsConfig.baseUrlAbs, normalizeSlashes(rawPath)))
      );
      if (baseUrlHit) {
        return vscode.Uri.file(baseUrlHit);
      }
    }

    // Sass allows non-prefixed module paths that are relative to the current file.
    if (!rawPath.startsWith("@")) {
      const implicitRelativeHit = resolveFirstExisting(
        buildCandidateList(path.resolve(sourceDir, normalizeSlashes(rawPath)))
      );
      if (implicitRelativeHit) {
        return vscode.Uri.file(implicitRelativeHit);
      }
    }

    if (!options.enableNodeModules) {
      return undefined;
    }

    const directRequireHit = resolveViaRequire(rawPath, sourceDir);
    if (directRequireHit && isFile(directRequireHit)) {
      return vscode.Uri.file(directRequireHit);
    }

    const packageHit = resolveViaPackageExports(rawPath, sourceDir, this.logger);
    if (packageHit) {
      return vscode.Uri.file(packageHit);
    }

    if (!hasExtension(rawPath)) {
      const implicitCss = resolveViaRequire(`${rawPath}.css`, sourceDir);
      if (implicitCss && isFile(implicitCss)) {
        return vscode.Uri.file(implicitCss);
      }
    }

    return undefined;
  }
}
