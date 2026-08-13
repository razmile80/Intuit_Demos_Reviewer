# Deploying Figma ↔ Video QA (single-box)

One always-on server runs everything. All state (runs, reports, scripts, anchors, dismissals) lives on a persistent volume — everyone who logs in shares the same run of show and can scan/rescan.

## Railway (recommended, ~10 min)

1. Push this folder to a private GitHub repo. Don't zip/upload — git skips the heavy stuff (`runs/`, `node_modules/`, videos) automatically via `.gitignore`, and `.env` is excluded too. In Terminal:

   ```bash
   cd ~/Documents/Claude/"Intuit Investors Reviewer"
   # clear stale lock files left by an earlier session:
   rm -f .git/HEAD.lock .git/index.lock .git/objects/maintenance.lock
   git add -A
   git commit -m "Figma-Video QA tool"
   git branch -M main
   git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
   git push -u origin main
   ```

   Replace `YOUR-USER/YOUR-REPO` with your repo's path (it's shown on the repo's empty page). If git asks you to sign in, follow the browser prompt.
2. railway.app → New Project → Deploy from GitHub repo. Railway detects the Dockerfile.
3. Service → Variables — add:
   - `ANTHROPIC_API_KEY` — from your .env
   - `FIGMA_TOKEN` — from your .env
   - `OPENAI_API_KEY` — from your .env
   - `APP_PASSWORD` — the shared team password (pick something strong)
4. Service → Settings → Volumes → Add volume, mount path: `/persist` (5–10 GB).
5. Settings → Networking → Generate Domain. Done — share the URL + password with the team.

## Migrating your local demos to the server

Everything you scanned locally lives in `runs/`, `reports/`, and `data/`. Copy them to the volume once:

```bash
# with Railway CLI installed and linked to the project:
railway ssh
# then from another terminal, copy up (or use `railway volume` tooling / scp on Fly):
```

Simplest path if CLI copying is awkward: zip the three folders, upload the zip anywhere private (Dropbox), then from `railway ssh`: download and unzip into `/persist/`. Restart the service afterward.

## Fly.io / Render

Same shape: Dockerfile build, mount a persistent disk at `/persist`, set the four env vars. On Fly: `fly launch` → `fly volumes create persist` → mount in fly.toml → `fly deploy`.

## Notes

- The password gate activates only when `APP_PASSWORD` is set — local dev stays open.
- Login lasts 30 days per browser (cookie).
- Batch scans run server-side; anyone can close their laptop mid-batch.
- Give the box ≥2 GB RAM (Playwright + ffmpeg headroom); 2 vCPU handles the 2-lane queue comfortably.
- Keep the repo private: it's client work, and although keys are not in the repo, reports will live on the server.
