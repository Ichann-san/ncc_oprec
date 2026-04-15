# Docker & VPS Deployment Guide — Antinude

This guide explains how to containerize the Antinude backend and deploy it to a VPS instead of (or alongside) Azure App Service.

---

## 1. Dockerfile (Multi-stage, Alpine, Optimized)

Create `Dockerfile` in the project root:

```dockerfile
# ---- Stage 1: Builder ----
FROM python:3.11-slim AS builder

WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---- Stage 2: Runtime ----
FROM python:3.11-alpine

# Install runtime deps for Pillow and onnxruntime
RUN apk add --no-cache libstdc++ libjpeg-turbo zlib

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application code and model
COPY main.py .
COPY student_model.onnx .
COPY student_model.onnx.data .

# Environment variables
ENV ANTINUDE_API_KEY=""
ENV PORT=8000

# Expose port
EXPOSE ${PORT}

# Healthcheck using the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/health || exit 1

# Run with gunicorn + uvicorn workers
CMD ["sh", "-c", "gunicorn main:app -w 2 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:${PORT}"]
```

### Key design decisions:
- **Multi-stage build**: Builder stage installs pip packages, runtime stage uses Alpine (~50MB smaller)
- **Alpine base**: `python:3.11-alpine` for minimal image size
- **HEALTHCHECK**: Docker will auto-monitor the `/health` endpoint
- **ENV-configurable**: API key and port via environment variables

> **Note:** `onnxruntime` may not work on Alpine out-of-the-box due to glibc dependency. If you hit issues, switch runtime to `python:3.11-slim` instead of Alpine. The multi-stage build still saves space.

---

## 2. .dockerignore

Create `.dockerignore` in the project root:

```
.git/
.github/
extension/
extension.pem
extension.crx
antinude.ipynb
__pycache__/
*.pyc
venv/
antenv/
.env
README.md
DOCKER_VPS_GUIDE.md
.gitignore
```

This keeps the build context minimal — only `main.py`, `requirements.txt`, and model files get sent to Docker.

---

## 3. docker-compose.yml

Create `docker-compose.yml`:

```yaml
version: "3.8"

services:
  antinude:
    build: .
    container_name: antinude-api
    ports:
      - "8000:8000"
    environment:
      - ANTINUDE_API_KEY=${ANTINUDE_API_KEY:-}
      - PORT=8000
    env_file:
      - .env  # optional, for local overrides
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

### .env file (for docker-compose):

```
ANTINUDE_API_KEY=your-secret-key-here
```

---

## 4. Build & Run Locally

```bash
# Build the image
docker build -t antinude-api .

# Run directly
docker run -d \
  --name antinude-api \
  -p 8000:8000 \
  -e ANTINUDE_API_KEY="your-key" \
  --restart unless-stopped \
  antinude-api

# Or use docker-compose
docker compose up -d

# Check health
curl http://localhost:8000/health

# Check logs
docker logs antinude-api

# Stop
docker compose down
```

---

## 5. Deploy to VPS

### Prerequisites
- A VPS (any provider: DigitalOcean, Vultr, Linode, AWS EC2, etc.)
- Ubuntu 22.04+ recommended
- At least 1GB RAM (model needs ~500MB)
- SSH access

### Step-by-step:

```bash
# 1. SSH into VPS
ssh user@your-vps-ip

# 2. Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
# Log out and back in for group changes

# 3. Install docker-compose
sudo apt install -y docker-compose-plugin

# 4. Clone your repo (or scp files)
git clone https://github.com/Ichann-san/antinude.git
cd antinude

# 5. Create .env file
echo "ANTINUDE_API_KEY=your-strong-random-key" > .env

# 6. Build and run
docker compose up -d --build

# 7. Verify
curl http://localhost:8000/health
# Expected: {"status":"healthy","model_loaded":true}

# 8. (Optional) Open firewall
sudo ufw allow 8000/tcp
```

### Making it publicly accessible:

After deployment, the endpoint is at: `http://your-vps-ip:8000`

For production, you should put it behind a reverse proxy (nginx) with HTTPS:

```bash
# Install nginx and certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Create nginx config at /etc/nginx/sites-available/antinude:
# server {
#     server_name your-domain.com;
#     location / {
#         proxy_pass http://localhost:8000;
#         proxy_set_header Host $host;
#         proxy_set_header X-Real-IP $remote_addr;
#         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
#     }
# }

# Enable and get SSL
sudo ln -s /etc/nginx/sites-available/antinude /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.com
sudo systemctl restart nginx
```

---

## 6. Summary

| Item | Status |
|------|--------|
| Service | FastAPI + ONNX inference |
| `/health` endpoint | Returns `200 OK` with model status |
| Dockerfile | Multi-stage, Alpine base, HEALTHCHECK |
| docker-compose | Restart policy, env vars, resource limits |
| .dockerignore | Optimized build context |
| VPS deployment | Docker install → clone → compose up |
| HTTPS | Via nginx reverse proxy + certbot |

### Potential issues you might face:
- `onnxruntime` on Alpine: if it fails, switch to `python:3.11-slim` as base
- Model file size (~96MB): first `docker build` takes a while to COPY. Consider using `.dockerignore` carefully
- Memory: the model loads ~500MB into RAM. Make sure your VPS has at least 1GB total
