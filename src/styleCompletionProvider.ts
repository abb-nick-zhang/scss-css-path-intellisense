import * as vscode from "vscode";
import type { Logger } from "./logger";
import { getPathCompletionContextAtPosition } from "./styleParser";
import type { CompletionCandidate, StylePathResolver } from "./stylePathResolver";

function toSortText(candidate: CompletionCandidate, rawPrefix: string): string {
  const prefix = rawPrefix.toLowerCase();
  const value = candidate.insertText.toLowerCase();

  const prefixRank = value === prefix ? "00" : value.startsWith(prefix) ? "01" : "02";
  const typeRank = candidate.isDirectory ? "0" : "1";
  return `${prefixRank}${typeRank}:${value}`;
}

export class StyleCompletionProvider implements vscode.CompletionItemProvider {
  public constructor(
    private readonly resolver: StylePathResolver,
    private readonly logger: Logger
  ) {}

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const config = vscode.workspace.getConfiguration("scssPathJump", document.uri);
    const enabled = config.get<boolean>("enablePathCompletion", true);
    if (!enabled) {
      return [];
    }

    const completionContext = getPathCompletionContextAtPosition(document, position);
    if (!completionContext) {
      return [];
    }

    const enableUrl = config.get<boolean>("enableUrl", true);
    if (completionContext.kind === "url" && !enableUrl) {
      return [];
    }

    const candidates = this.resolver.getCompletionCandidates(document, completionContext.rawPath);
    if (!candidates.length) {
      return [];
    }

    const items: vscode.CompletionItem[] = [];
    for (const candidate of candidates) {
      const item = new vscode.CompletionItem(
        candidate.label,
        candidate.isDirectory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
      );

      item.insertText = candidate.insertText;
      item.range = completionContext.range;
      item.detail = candidate.detail;
      item.filterText = candidate.insertText;
      item.sortText = toSortText(candidate, completionContext.rawPath);

      if (candidate.isDirectory) {
        item.command = {
          command: "editor.action.triggerSuggest",
          title: "Trigger path suggestions"
        };
      }

      items.push(item);
    }

    this.logger.debug(
      `Completion '${completionContext.rawPath}' -> ${items.length} candidates (${completionContext.kind})`
    );

    return items;
  }
}
