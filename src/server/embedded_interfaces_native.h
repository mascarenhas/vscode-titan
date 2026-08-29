#ifndef VSCODE_TITAN_EMBEDDED_INTERFACES_NATIVE_H
#define VSCODE_TITAN_EMBEDDED_INTERFACES_NATIVE_H

#include "lua.h"

/* Register Titan's metadata-free compiler support table as package.preload
 * "titan", then push the metadata-only standard-library interface provider.
 * This neither initializes nor registers any of the native titan.* modules. */
int titan_ls_push_embedded_interface_provider(lua_State *L);

/* Push the followed filesystem identity paired with the running executable
 * while the embedded provider is constructed. */
int titan_ls_push_embedded_provider_identity(lua_State *L);

#endif
