import type { Uri } from "vscode";

type UriPath = Pick<Uri, "scheme" | "authority" | "path">;

export function workspaceRootPath(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") {
    end--;
  }
  return end === path.length ? path : path.slice(0, end);
}

function comparisonPath(uri: UriPath, platform: NodeJS.Platform): string {
  // Uri.fsPath lowercases the drive, but Uri.path retains its spelling.
  if (platform === "win32" && uri.scheme === "file" && uri.authority === "" &&
      /^\/[a-z]:(?:\/|$)/.test(uri.path)) {
    return `/${uri.path[1].toUpperCase()}${uri.path.slice(2)}`;
  }
  return uri.path;
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
  const rootPath = workspaceRootPath(comparisonPath(root, platform));
  const path = comparisonPath(uri, platform);
  if (workspaceRootPath(path) === rootPath) {
    return "";
  }
  const prefix = rootPath === "/" ? "/" : `${rootPath}/`;
  return path.startsWith(prefix) ? uri.path.slice(prefix.length) : undefined;
}
