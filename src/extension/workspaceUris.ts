import * as vscode from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient/node";

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
  const lexicalRoot = normalizedRootUri(folder.uri);
  const physicalRoot = normalizedRootUri(vscode.Uri.file(physicalWorkspaceRoot));

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

function normalizedRootUri(uri: vscode.Uri): vscode.Uri {
  let rootPath = uri.path;
  while (rootPath.length > 1 && rootPath.endsWith("/")) {
    rootPath = rootPath.slice(0, -1);
  }
  return uri.with({ path: rootPath, query: "", fragment: "" });
}

function mapUriRoot(
  uri: vscode.Uri,
  sourceRoot: vscode.Uri,
  targetRoot: vscode.Uri
): vscode.Uri | undefined {
  if (uri.scheme !== sourceRoot.scheme ||
      uri.authority !== sourceRoot.authority) {
    return undefined;
  }

  let relativePath: string;
  if (uri.path === sourceRoot.path) {
    relativePath = "";
  } else {
    const prefix = sourceRoot.path === "/" ? "/" : `${sourceRoot.path}/`;
    if (!uri.path.startsWith(prefix)) {
      return undefined;
    }
    relativePath = uri.path.slice(prefix.length);
  }

  const targetPath = relativePath.length === 0
    ? targetRoot.path
    : targetRoot.path === "/"
      ? `/${relativePath}`
      : `${targetRoot.path}/${relativePath}`;
  return targetRoot.with({
    path: targetPath,
    query: uri.query,
    fragment: uri.fragment
  });
}
