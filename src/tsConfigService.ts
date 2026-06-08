import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parse } from "jsonc-parser";
import type { Logger } from "./logger";

interface CompilerOptionsShape {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

interface TsConfigShape {
  extends?: string;
  compilerOptions?: CompilerOptionsShape;
}

export interface ResolvedTsConfig {
  configPath: string;
  configDir: string;
  baseUrlAbs: string;
  paths: Record<string, string[]>;
}

interface CacheEntry {
  mtimeMs: number;
  result: ResolvedTsConfig;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeCompilerOptions(compilerOptions: CompilerOptionsShape | undefined): CompilerOptionsShape {
  if (!compilerOptions) {
    return {};
  }

  return {
    baseUrl: compilerOptions.baseUrl,
    paths: compilerOptions.paths ?? {}
  };
}

function mergeCompilerOptions(parent: CompilerOptionsShape, current: CompilerOptionsShape): CompilerOptionsShape {
  const mergedPaths: Record<string, string[]> = {};
  if (parent.paths) {
    Object.assign(mergedPaths, parent.paths);
  }
  if (current.paths) {
    Object.assign(mergedPaths, current.paths);
  }

  return {
    baseUrl: current.baseUrl ?? parent.baseUrl,
    paths: mergedPaths
  };
}

function readJsoncFile<T>(filePath: string): T {
  const text = fs.readFileSync(filePath, "utf8");
  return parse(text) as T;
}

function resolveExtendsPath(extendsValue: string, fromDir: string): string | undefined {
  const withJsonExtension = (candidate: string): string => {
    if (path.extname(candidate)) {
      return candidate;
    }

    return `${candidate}.json`;
  };

  if (extendsValue.startsWith(".") || extendsValue.startsWith("/") || /^[A-Za-z]:[\\/]/.test(extendsValue)) {
    const absoluteCandidate = withJsonExtension(path.resolve(fromDir, extendsValue));
    if (fileExists(absoluteCandidate)) {
      return absoluteCandidate;
    }

    return undefined;
  }

  try {
    return require.resolve(extendsValue, { paths: [fromDir] });
  } catch {
    try {
      return require.resolve(path.posix.join(extendsValue, "tsconfig.json"), { paths: [fromDir] });
    } catch {
      return undefined;
    }
  }
}

function loadCompilerOptionsRecursively(configPath: string, visited: Set<string>, logger: Logger): CompilerOptionsShape {
  const normalizedConfigPath = normalizePath(configPath);

  if (visited.has(normalizedConfigPath)) {
    logger.error(`Detected tsconfig extends cycle at ${normalizedConfigPath}`);
    return {};
  }

  visited.add(normalizedConfigPath);

  const parsed = readJsoncFile<TsConfigShape>(configPath);
  const currentCompilerOptions = normalizeCompilerOptions(parsed.compilerOptions);

  if (!parsed.extends) {
    return currentCompilerOptions;
  }

  const extendedConfigPath = resolveExtendsPath(parsed.extends, path.dirname(configPath));
  if (!extendedConfigPath) {
    logger.error(`Could not resolve tsconfig extends '${parsed.extends}' from ${configPath}`);
    return currentCompilerOptions;
  }

  const parentCompilerOptions = loadCompilerOptionsRecursively(extendedConfigPath, visited, logger);
  return mergeCompilerOptions(parentCompilerOptions, currentCompilerOptions);
}

function findNearestConfig(documentUri: vscode.Uri): string | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  if (!workspaceFolder) {
    return undefined;
  }

  const workspaceRoot = path.resolve(workspaceFolder.uri.fsPath);
  let currentDir = path.dirname(documentUri.fsPath);

  for (;;) {
    const tsConfigPath = path.join(currentDir, "tsconfig.json");
    if (fileExists(tsConfigPath)) {
      return tsConfigPath;
    }

    const jsConfigPath = path.join(currentDir, "jsconfig.json");
    if (fileExists(jsConfigPath)) {
      return jsConfigPath;
    }

    if (currentDir === workspaceRoot) {
      break;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  const fallbackTsConfigPath = path.join(workspaceRoot, "tsconfig.json");
  if (fileExists(fallbackTsConfigPath)) {
    return fallbackTsConfigPath;
  }

  const fallbackJsConfigPath = path.join(workspaceRoot, "jsconfig.json");
  if (fileExists(fallbackJsConfigPath)) {
    return fallbackJsConfigPath;
  }

  return undefined;
}

export class TsConfigService {
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(private readonly logger: Logger) {}

  public getForDocument(documentUri: vscode.Uri): ResolvedTsConfig | undefined {
    const configPath = findNearestConfig(documentUri);
    if (!configPath) {
      this.logger.debug(`No tsconfig/jsconfig found for ${documentUri.fsPath}`);
      return undefined;
    }

    const stat = fs.statSync(configPath);
    const cacheHit = this.cache.get(configPath);
    if (cacheHit?.mtimeMs === stat.mtimeMs) {
      return cacheHit.result;
    }

    const compilerOptions = loadCompilerOptionsRecursively(configPath, new Set<string>(), this.logger);
    const configDir = path.dirname(configPath);
    const baseUrlAbs = compilerOptions.baseUrl
      ? path.resolve(configDir, compilerOptions.baseUrl)
      : configDir;

    const result: ResolvedTsConfig = {
      configPath,
      configDir,
      baseUrlAbs,
      paths: compilerOptions.paths ?? {}
    };

    this.cache.set(configPath, {
      mtimeMs: stat.mtimeMs,
      result
    });

    return result;
  }

  public clear(): void {
    this.cache.clear();
  }
}
