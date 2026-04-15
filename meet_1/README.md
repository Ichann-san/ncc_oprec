# Antinude — NSFW Content Blocker

Real-time NSFW content detection Chrome extension powered by a ResNet50 machine learning model, deployed on Microsoft Azure.

## Architecture

```
┌──────────────────────┐         HTTPS POST           ┌──────────────────────────┐
│   Chrome Extension   │  ──────────────────────────>  │   Azure App Service      │
│                      │      /predict                 │   (FastAPI + ONNX)       │
│  background.js       │      { image_base64: "..." }  │                          │
│  - captures tab      │      X-API-Key: <key>         │  main.py                 │
│  - sends screenshot  │                               │  - validates API key     │
│                      │  <──────────────────────────  │  - rate limits           │
│  content.js          │      { status, confidence }   │  - preprocesses image    │
│  - applies blur      │                               │  - runs ONNX inference   │
│  - anti-tampering    │                               │  - returns prediction    │
└──────────────────────┘                               └──────────────────────────┘
```

## How It Works

### End-to-End Flow

1. **Extension installs** → `background.js` starts a `setInterval` loop (300ms interval)
2. **On each tick** → captures a JPEG screenshot of the active tab
3. **Sends base64-encoded image** → `POST /predict` with `X-API-Key` header
4. **Backend receives request** → validates API key → checks rate limit → validates payload size
5. **Image preprocessing** → decode base64 → downscale if too large → resize to 224×224 → ImageNet normalization
6. **ONNX inference** → ResNet50 student model → sigmoid output → probability score
7. **Classification** → `score > 0.5` = NSFW, else Safe
8. **If NSFW** → background.js sends `EXECUTE_BLUR` message to content.js
9. **content.js** → injects fullscreen blur overlay with warning popup
10. **Anti-tampering** → MutationObserver re-applies blur if user tries to remove via DevTools

### Model

- **Architecture:** ResNet50 (transfer learning)
- **Training:** Knowledge distillation from a teacher model
- **Format:** ONNX (CPU inference via `onnxruntime`)
- **Input:** 224×224 RGB image, ImageNet-normalized
- **Output:** Single sigmoid score (0 = safe, 1 = nsfw)
- **Threshold:** 0.5

---

## Project Structure

```
antinude/
├── main.py                          # FastAPI backend server
├── requirements.txt                 # Python dependencies (pinned)
├── student_model.onnx               # ONNX model weights (metadata)
├── student_model.onnx.data          # ONNX model weights (data, ~96MB)
├── .gitignore                       # Git ignore rules
├── .github/
│   └── workflows/
│       └── main_antinsfw.yml        # Azure CI/CD pipeline
└── extension/
    ├── manifest.json                # Chrome extension manifest (MV3)
    ├── background.js                # Service worker — capture & send
    └── content.js                   # Content script — blur & anti-tamper
```

---

## API Reference

### `GET /`
Returns service status.
```json
{ "status": "ok", "service": "Antinude API" }
```

### `GET /health`
Health check endpoint. Returns model load status.
```json
{ "status": "healthy", "model_loaded": true }
```

### `POST /predict`
Classify an image as safe or nsfw.

**Headers:**
| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/json` |
| `X-API-Key` | Conditional | Required if `ANTINUDE_API_KEY` is set on server |

**Body:**
```json
{ "image_base64": "<base64-encoded JPEG>" }
```

**Response (200):**
```json
{ "status": "safe", "confidence": 0.1234 }
```
or
```json
{ "status": "nsfw", "confidence": 0.8765 }
```

**Error Responses:**
| Code | Meaning |
|------|---------|
| 400 | Invalid image or processing error |
| 401 | Invalid or missing API key |
| 429 | Rate limit exceeded (120 req/min per IP) |
| 503 | Model not loaded |

---

## Setup & Deployment

### Backend (Azure App Service)

The backend auto-deploys via GitHub Actions on push to `main`.

**Environment Variables (set in Azure App Service → Configuration):**

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTINUDE_API_KEY` | Optional | API key for request auth. Leave empty to disable auth. |

**Manual local run:**
```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

### Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. The extension icon appears in the toolbar — it's now active

**API Key setup:** If you set `ANTINUDE_API_KEY` on the server, update the `API_KEY` constant in `extension/background.js` to match.

---

## Security

### Implemented Protections

| Layer | Protection |
|-------|-----------|
| **Auth** | API key via `X-API-Key` header (env-configurable) |
| **CORS** | Restricted to `chrome-extension://` origins only |
| **Rate Limit** | 120 requests/minute per IP (sliding window) |
| **Payload Limit** | Max 5MB base64 payload per request |
| **Image Safety** | Large images downscaled before processing |
| **Error Handling** | No internal details leaked in error responses |
| **Docs Disabled** | Swagger/ReDoc UI disabled in production |

> [!IMPORTANT]
> ### Before Going Public
> 1. **Regenerate `extension.pem`** — the old key was previously committed to a public repo
> 2. **Purge git history** — run `git filter-repo --path extension.pem --invert-paths` then force-push
> 3. **Set `ANTINUDE_API_KEY`** — configure a strong key in Azure App Settings
> 4. **Update `API_KEY` in `background.js`** — must match the server key
> 5. **Consider Git LFS** for model files (`student_model.onnx*`) — they're ~96MB

---

## CI/CD

GitHub Actions workflow (`.github/workflows/main_antinsfw.yml`):
- Triggers on push to `main` branch
- Builds on Ubuntu with Python 3.11
- Deploys to Azure App Service `antinsfw` using OIDC auth (no passwords stored)
- Azure credentials are stored as GitHub repository secrets

---

## Rate Limits & Performance

- **Scan interval:** 300ms (via `setInterval`)
- **Rate limit:** 120 requests/min per IP
- **Error backoff:** After 5 consecutive failures, pauses for 30 seconds
- **Image quality:** JPEG @ 50% quality (reduces payload size)
- **Inference:** ~100-300ms per image on CPU (Azure App Service)

---

## License

Private project. All rights reserved.
