import * as vscode from "vscode";

export type LogLevel = "off" | "error" | "debug";

export class Logger {
  private readonly channel: vscode.OutputChannel;

  public constructor(private logLevel: LogLevel) {
    this.channel = vscode.window.createOutputChannel("SCSS Path IntelliSense");
  }

  public updateLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  public dispose(): void {
    this.channel.dispose();
  }

  public error(message: string): void {
    if (this.logLevel === "off") {
      return;
    }

    this.channel.appendLine(`[error] ${message}`);
  }

  public debug(message: string): void {
    if (this.logLevel !== "debug") {
      return;
    }

    this.channel.appendLine(`[debug] ${message}`);
  }
}
