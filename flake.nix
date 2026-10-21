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

        # ── dev services (mirrors docker-compose.yml / .env.example) ──────────
        # Data lives in ./.data at the repo root; wipe it with `rm -rf .data`.
        # Postgres and Redis run as user processes via process-compose, so this
        # works on any Linux distro (no NixOS required).

        postgresql = pkgs.postgresql_18;
        dataDir = ".data";

        postgresServer = pkgs.writeShellScript "dev-postgres" ''
          set -euo pipefail
          export PGDATA="$PWD/${dataDir}/postgres"
          if [ ! -s "$PGDATA/PG_VERSION" ]; then
            echo "==> postgres: initialising data dir at $PGDATA"
            mkdir -p "$PGDATA"
            ${postgresql}/bin/initdb -U postgres --auth=trust
          fi
          exec ${postgresql}/bin/postgres -D "$PGDATA" -k /tmp -h 127.0.0.1
        '';

        postgresInit = pkgs.writeShellScript "dev-postgres-init" ''
          set -euo pipefail
          if ! ${postgresql}/bin/psql -h 127.0.0.1 -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='catalog_forge'" | grep -q 1; then
            ${postgresql}/bin/createdb -h 127.0.0.1 -U postgres catalog_forge
          fi
          echo "==> postgres: database catalog_forge ready"
        '';

        redisServer = pkgs.writeShellScript "dev-redis" ''
          set -euo pipefail
          mkdir -p "$PWD/${dataDir}/redis"
          exec ${pkgs.redis}/bin/redis-server --bind 127.0.0.1 --port 6379 --dir "$PWD/${dataDir}/redis"
        '';

        # Garage (S3) — MinIO was archived upstream (2026-02) and removed from
        # nixpkgs; Garage is the maintained replacement we standardise on.
        # rpc_secret/admin_token match garage.toml (docker variant). The secret
        # key/id granted on the bucket live in scripts/garage-provision.sh.
        garageServer = pkgs.writeShellScript "dev-garage" ''
          set -euo pipefail
          d="$PWD/${dataDir}/garage"
          mkdir -p "$d/meta" "$d/data"
          cat > "$d/garage.toml" <<EOF
          replication_factor = 1
          metadata_dir = "$d/meta"
          data_dir = "$d/data"
          rpc_secret = "da320c2505a1eec2dabaecae5b1a177150baaa818e3b483b655457458aff203e"
          rpc_bind_addr = "127.0.0.1:3901"

          [s3_api]
          api_bind_addr = "127.0.0.1:9000"
          s3_region = "us-east-1"

          [admin]
          api_bind_addr = "127.0.0.1:3903"
          admin_token = "dev-admin-token"
          EOF
          exec ${pkgs.garage}/bin/garage -c "$d/garage.toml" server
        '';

        # Reuses the same provisioning script as the docker flow, pointed at
        # the nix-run garage instead of `docker compose exec`.
        garageInit = pkgs.writeShellScript "dev-garage-init" ''
          set -euo pipefail
          export GARAGE="${pkgs.garage}/bin/garage -c $PWD/${dataDir}/garage/garage.toml"
          exec ${pkgs.bash}/bin/bash ${./scripts/garage-provision.sh}
        '';

        processesConfig = pkgs.writeText "catalog-forge-processes.yaml" ''
          version: "0.5"

          processes:
            postgres:
              command: "${postgresServer}"
              readiness_probe:
                initial_delay_seconds: 1
                period_seconds: 2
                timeout_seconds: 2
                failure_threshold: 30
                exec:
                  command: "${postgresql}/bin/pg_isready -h 127.0.0.1 -p 5432 -U postgres"
              availability:
                exit_on_termination: true

            postgres-init:
              command: "${postgresInit}"
              depends_on:
                postgres:
                  condition: process_healthy
              availability:
                exit_on_termination: false
                restart: on_failure

            redis:
              command: "${redisServer}"
              readiness_probe:
                initial_delay_seconds: 1
                period_seconds: 2
                failure_threshold: 30
                tcp_probe:
                  host: "127.0.0.1"
                  port: 6379
              availability:
                exit_on_termination: true

            garage:
              command: "${garageServer}"
              readiness_probe:
                initial_delay_seconds: 1
                period_seconds: 2
                failure_threshold: 30
                http_get:
                  scheme: "http"
                  host: "127.0.0.1"
                  port: 3903
                  path: "/health"
              availability:
                exit_on_termination: true

            garage-init:
              command: "${garageInit}"
              depends_on:
                garage:
                  condition: process_healthy
              availability:
                exit_on_termination: false
                restart: on_failure
        '';

        servicesRunner = pkgs.writeShellScript "dev-services" ''
          if [ ! -f ./flake.nix ]; then
            echo "error: run from the repository root (service data lives in ./.data)" >&2
            exit 1
          fi
          mkdir -p ${dataDir}
          exec ${pkgs.process-compose}/bin/process-compose --config "${processesConfig}" "$@"
        '';
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              nodejs_24
              corepack_24
              curl
              pkg-config

              boost

              # dev-service CLIs — endpoints match docker-compose.yml/.env.example
              process-compose
            ]
            ++ [
              postgresql # psql, pg_dump, pg_isready
              redis # redis-cli
              garage # garage CLI: garage -c .data/garage/garage.toml status
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
            echo "dev services: nix run .#services  (docker alternative: pnpm services:up)"
          '';
        };

        apps.services = {
          type = "app";
          program = "${servicesRunner}";
        };
      }
    );
}
