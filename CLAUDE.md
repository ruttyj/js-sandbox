# GE Tracker

## Running the app locally

- Plain `docker compose up` starts it in production mode (the code baked into the image). That's
  the project default, so leave `docker-compose.yml` that way.
- The user is developing, so when they ask to start, restart or rebuild the container, use dev
  mode unless they say otherwise:

  ```sh
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
  ```

  `docker-compose.dev.yml` mounts `server/` and `public/` and runs `tools/dev-server.mjs`. Server
  edits then restart it automatically, and `public/` edits need only a browser refresh.
- While dev mode is running, code changes are already live. Don't restart for them; rebuild only
  after changing `package.json` or the `Dockerfile`.
- Check which mode is running with `docker logs ge-tracker-app-1`. Lines starting `[dev-server]`
  mean dev mode.
- `npm run dev` outside Docker uses a different database (`storage/`), so stick to the container
  unless asked.
