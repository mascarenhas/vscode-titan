import * as vscode from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient/node";
import { mapUriRoot } from "./uriPaths";

const TITAN_DOCUMENT_GLOB = "**/*.titan";

export interface WorkspaceDocumentFilter {
  language: string;
  scheme: string;
  pattern: {
    baseUri: string;
    pattern: string;
  };
}

export function createWorkspaceDocumentSelector(
  folder: vscode.WorkspaceFolder
): WorkspaceDocumentFilter[] {
  return [{
    language: "titan",
    scheme: folder.uri.scheme,
    pattern: {
      baseUri: folder.uri.toString(),
      pattern: TITAN_DOCUMENT_GLOB
    }
  }];
}

export function createWorkspaceUriConverters(
  folder: vscode.WorkspaceFolder,
  physicalWorkspaceRoot: string = folder.uri.fsPath
): NonNullable<LanguageClientOptions["uriConverters"]> {
  const workspaceScheme = folder.uri.scheme;
  const workspaceAuthority = folder.uri.authority;
  const lexicalRoot = folder.uri;
  const physicalRoot = vscode.Uri.file(physicalWorkspaceRoot);

  return {
    code2Protocol: (uri) => {
      const physical = mapUriRoot(uri, lexicalRoot, physicalRoot);
      if (physical !== undefined) {
        return physical.toString();
      }
      if (workspaceScheme !== "file" &&
          uri.scheme === workspaceScheme &&
          uri.authority === workspaceAuthority) {
        return uri.with({ scheme: "file", authority: "" }).toString();
      }
      return uri.toString();
    },
    protocol2Code: (value) => {
      const uri = vscode.Uri.parse(value);
      const lexical = mapUriRoot(uri, physicalRoot, lexicalRoot);
      if (lexical !== undefined) {
        return lexical;
      }
      if (workspaceScheme !== "file" && uri.scheme === "file") {
        return uri.with({
          scheme: workspaceScheme,
          authority: workspaceAuthority
        });
      }
      return uri;
    }
  };
}

export function createWorkspaceMiddleware(
  folder: vscode.WorkspaceFolder
): NonNullable<LanguageClientOptions["middleware"]> {
  const owns = (document: vscode.TextDocument): boolean =>
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ===
      folder.uri.toString();

  return {
    didOpen: (document, next) =>
      owns(document) ? next(document) : Promise.resolve(),
    didChange: (event, next) =>
      owns(event.document) ? next(event) : Promise.resolve(),
    didClose: (document, next) =>
      owns(document) ? next(document) : Promise.resolve(),
    didSave: (document, next) =>
      owns(document) ? next(document) : Promise.resolve(),
    provideCompletionItem: (document, position, context, token, next) =>
      owns(document) ? next(document, position, context, token) : undefined,
    provideDefinition: (document, position, token, next) =>
      owns(document) ? next(document, position, token) : undefined,
    provideReferences: (document, position, options, token, next) =>
      owns(document)
        ? next(document, position, options, token)
        : undefined,
    provideHover: (document, position, token, next) =>
      owns(document) ? next(document, position, token) : undefined,
    provideRenameEdits: (document, position, newName, token, next) =>
      owns(document)
        ? next(document, position, newName, token)
        : undefined,
    prepareRename: (document, position, token, next) =>
      owns(document) ? next(document, position, token) : undefined,
    provideFoldingRanges: (document, context, token, next) =>
      owns(document) ? next(document, context, token) : undefined
  };
}
