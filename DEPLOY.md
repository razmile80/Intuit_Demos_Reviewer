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

Everything you scanned locally lives in `runs/`, `reports/`, and `data/`. One-time copy via Dropbox:

1. **Pack them** — Terminal on your Mac:
   ```bash
   cd ~/Documents/Claude/"Intuit Investors Reviewer"
   tar -czf ~/Desktop/demos.tgz runs reports data
   ```
2. **Upload `demos.tgz` to Dropbox**, copy its share link, and change the ending `dl=0` to `dl=1`.
3. **Install the Railway CLI** and connect it:
   ```bash
   npm i -g @railway/cli
   railway login        # opens the browser
   railway link         # pick your project, environment, and service
   ```
4. **SSH into the server and pull the archive in**:
   ```bash
   railway ssh
   # now you're on the server:
   cd /persist
   curl -L "PASTE-YOUR-DROPBOX-LINK-WITH-dl=1" -o demos.tgz
   tar -xzf demos.tgz
   rm demos.tgz
   ls runs        # should list your run folders
   exit
   ```
5. Refresh the app URL — the run of show shows all your demos. No restart needed. Delete the Dropbox file afterward (client material).

## Fly.io / Render

Same shape: Dockerfile build, mount a persistent disk at `/persist`, set the four env vars. On Fly: `fly launch` → `fly volumes create persist` → mount in fly.toml → `fly deploy`.

## Notes

- The password gate activates only when `APP_PASSWORD` is set — local dev stays open.
- Login lasts 30 days per browser (cookie).
- Batch scans run server-side; anyone can close their laptop mid-batch.
- Give the box ≥2 GB RAM (Playwright + ffmpeg headroom); 2 vCPU handles the 2-lane queue comfortably.
- Keep the repo private: it's client work, and although keys are not in the repo, reports will live on the server.
