import * as vscode from "vscode";
import { Logger, type LogLevel } from "./logger";
import { getTokenAtPosition, parsePathTokens } from "./styleParser";
import { StyleCompletionProvider } from "./styleCompletionProvider";
import { StylePathResolver } from "./stylePathResolver";
import { TsConfigService } from "./tsConfigService";

function getLogLevel(documentUri?: vscode.Uri): LogLevel {
  const config = vscode.workspace.getConfiguration("scssPathJump", documentUri);
  return config.get<LogLevel>("logLevel", "error");
}

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger(getLogLevel());
  const tsConfigService = new TsConfigService(logger);
  const resolver = new StylePathResolver(tsConfigService, logger);
  const completionProvider = new StyleCompletionProvider(resolver, logger);

  const loggerDisposable: vscode.Disposable = {
    dispose: () => logger.dispose()
  };

  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("scssPathJump.logLevel")) {
      logger.updateLevel(getLogLevel());
    }

    if (event.affectsConfiguration("scssPathJump")) {
      tsConfigService.clear();
      resolver.clearCache();
    }
  });

  const selector: vscode.DocumentSelector = [
    { language: "scss", scheme: "file" },
    { language: "css", scheme: "file" }
  ];

  const definitionProvider: vscode.DefinitionProvider = {
    provideDefinition(document, position) {
      const token = getTokenAtPosition(document, position);
      if (!token) {
        return undefined;
      }

      const target = resolver.resolvePath(document, token);
      if (!target) {
        logger.debug(`No target resolved for '${token.rawPath}'`);
        return undefined;
      }

      logger.debug(`Resolved '${token.rawPath}' -> ${target.fsPath}`);
      return new vscode.Location(target, new vscode.Position(0, 0));
    }
  };

  const documentLinkProvider: vscode.DocumentLinkProvider = {
    provideDocumentLinks(document) {
      const config = vscode.workspace.getConfiguration("scssPathJump", document.uri);
      const enabled = config.get<boolean>("enableDocumentLinks", true);
      if (!enabled) {
        return [];
      }

      const tokens = parsePathTokens(document);
      const links: vscode.DocumentLink[] = [];

      for (const token of tokens) {
        const target = resolver.resolvePath(document, token);
        if (!target) {
          continue;
        }

        links.push(new vscode.DocumentLink(token.range, target));
      }

      return links;
    }
  };

  const definitionDisposable = vscode.languages.registerDefinitionProvider(selector, definitionProvider);
  const linkDisposable = vscode.languages.registerDocumentLinkProvider(selector, documentLinkProvider);
  const completionDisposable = vscode.languages.registerCompletionItemProvider(
    selector,
    completionProvider,
    "/",
    ".",
    "\"",
    "'",
    "@"
  );

  const configWatcher = vscode.workspace.createFileSystemWatcher("**/{tsconfig.json,jsconfig.json}");
  const clearAllCaches = (): void => {
    tsConfigService.clear();
    resolver.clearCache();
  };

  configWatcher.onDidCreate(clearAllCaches);
  configWatcher.onDidChange(clearAllCaches);
  configWatcher.onDidDelete(clearAllCaches);

  context.subscriptions.push(
    loggerDisposable,
    configChangeDisposable,
    definitionDisposable,
    linkDisposable,
    completionDisposable,
    configWatcher
  );
}

export function deactivate(): void {
  // Nothing to clean up. Disposable resources are registered in context.subscriptions.
}
