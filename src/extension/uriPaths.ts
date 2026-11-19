import type { Uri } from "vscode";

type UriPath = Pick<Uri, "scheme" | "authority" | "path">;

function localWindowsDrive(uri: UriPath, platform: NodeJS.Platform): boolean {
  return platform === "win32" && uri.scheme === "file" && uri.authority === "" &&
    /^\/[a-zA-Z]:\//.test(uri.path);
}

function workspaceRootPath(uri: UriPath, platform: NodeJS.Platform,
                           compare = false): string {
  const drive = localWindowsDrive(uri, platform);
  const { path } = uri;
  // Unlike a drive root, an authority-backed UNC share is absolute without
  // its optional trailing slash. Keep the entire share component.
  const minimum = drive ? 4 : 1;
  let end = path.length;
  while (end > minimum && path[end - 1] === "/") {
    end--;
  }
  if (compare && drive && path[1] >= "a" && path[1] <= "z") {
    return `/${path[1].toUpperCase()}${path.slice(2, end)}`;
  }
  return end === path.length ? path : path.slice(0, end);
}

function workspacePrefix(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

// Return the original suffix, or an empty string for the root itself.
export function relativeWorkspaceUriPath(
  root: UriPath,
  uri: UriPath,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (uri.scheme !== root.scheme || uri.authority !== root.authority) {
    return undefined;
  }
  const rootPath = workspaceRootPath(root, platform, true);
  const path = workspaceRootPath(uri, platform, true);
  if (path === rootPath) {
    return "";
  }
  const prefix = workspacePrefix(rootPath);
  return path.startsWith(prefix) ? uri.path.slice(prefix.length) : undefined;
}

type UriComponents = Pick<Uri, "path" | "query" | "fragment">;
type MappableUri = UriPath & UriComponents;

export function mapUriRoot<T>(
  uri: MappableUri,
  sourceRoot: UriPath,
  targetRoot: UriPath & { with(change: UriComponents): T },
  platform: NodeJS.Platform = process.platform
): T | undefined {
  const relative = relativeWorkspaceUriPath(sourceRoot, uri, platform);
  if (relative === undefined) {
    return undefined;
  }
  const rootPath = workspaceRootPath(targetRoot, platform);
  return targetRoot.with({
    path: relative === "" ? rootPath : workspacePrefix(rootPath) + relative,
    query: uri.query,
    fragment: uri.fragment
  });
}
