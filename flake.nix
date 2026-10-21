{
  description = "catalog forge";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            corepack_24
            curl
            pkg-config
          ];

          # Corepack refuses to write shims into the read-only Nix store, so
          # point it at a project-local, gitignored directory instead.
          shellHook = ''
            export COREPACK_HOME="$PWD/.corepack"
            mkdir -p "$COREPACK_HOME/bin"
            corepack enable --install-directory "$COREPACK_HOME/bin" >/dev/null 2>&1
            export PATH="$COREPACK_HOME/bin:$PATH"

            corepack prepare pnpm@12 --activate >/dev/null 2>&1 || true

            echo "node $(node --version) · pnpm $(pnpm --version 2>/dev/null || echo 'n/a')"
          '';
        };
      }
    );
}
