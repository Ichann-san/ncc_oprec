import os
import logging
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
import base64
from io import BytesIO
from PIL import Image
import numpy as np
import onnxruntime as ort

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("antinude")

# --- Config ---
API_KEY = os.environ.get("ANTINUDE_API_KEY", "")
MAX_PAYLOAD_BYTES = 5 * 1024 * 1024  # 5MB max base64 payload
NSFW_THRESHOLD = 0.5
MODEL_PATH = "student_model.onnx"

# --- App Init ---
app = FastAPI(title="Antinude API", docs_url=None, redoc_url=None)


# --- CORS (restricted to extension origin) ---
# Chrome extensions use origin: chrome-extension://<extension-id>
# We allow all chrome-extension origins since the ID varies per install
ALLOWED_ORIGINS = [
    "chrome-extension://*",
]

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type", "X-API-Key"],
)


# --- API Key Auth ---
async def verify_api_key(request: Request):
    """Validate the API key from request header. Skipped if no key is configured."""
    if not API_KEY:
        return  # No key configured, skip auth (dev mode)
    key = request.headers.get("X-API-Key", "")
    if key != API_KEY:
        logger.warning(f"Unauthorized request from {request.client.host}")
        raise HTTPException(status_code=401, detail="Invalid API key")


# --- Rate Limiting (simple in-memory) ---
from collections import defaultdict
import time

rate_limit_store: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX = 120     # max requests per window


async def check_rate_limit(request: Request):
    """Simple sliding window rate limiter per IP."""
    client_ip = request.client.host
    now = time.time()
    # Clean old entries
    rate_limit_store[client_ip] = [
        t for t in rate_limit_store[client_ip] if now - t < RATE_LIMIT_WINDOW
    ]
    if len(rate_limit_store[client_ip]) >= RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    rate_limit_store[client_ip].append(now)


# --- Request Model ---
class ImagePayload(BaseModel):
    image_base64: str

    @field_validator("image_base64")
    @classmethod
    def validate_size(cls, v: str) -> str:
        if len(v) > MAX_PAYLOAD_BYTES:
            raise ValueError(f"Payload too large (max {MAX_PAYLOAD_BYTES // 1024 // 1024}MB)")
        if not v:
            raise ValueError("Empty image payload")
        return v


# --- Load ONNX Model ---
ort_session = None
input_name = None

try:
    logger.info("Loading ONNX model...")
    ort_session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    input_name = ort_session.get_inputs()[0].name
    logger.info("Model loaded successfully.")
except Exception as e:
    logger.error(f"Failed to load model: {e}")
    # Server will start but /predict will return 503


# --- Image Preprocessing ---
def preprocess_image(image: Image.Image) -> np.ndarray:
    """Resize, normalize (ImageNet stats), and format for ONNX inference."""
    # Resize to 224x224 (ResNet50 input)
    img = image.resize((224, 224))
    img_np = np.array(img, dtype=np.float32) / 255.0

    # ImageNet normalization
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    img_np = (img_np - mean) / std

    # HWC -> CHW (PyTorch format)
    img_np = np.transpose(img_np, (2, 0, 1))

    # Add batch dimension -> (1, 3, 224, 224)
    return np.expand_dims(img_np, axis=0)


# --- Endpoints ---
@app.get("/")
async def root():
    return {"status": "ok", "service": "Antinude API"}


@app.get("/health")
async def health():
    """Health check endpoint for monitoring and Docker HEALTHCHECK."""
    model_ok = ort_session is not None
    return {
        "status": "healthy" if model_ok else "degraded",
        "model_loaded": model_ok,
    }


@app.post("/predict", dependencies=[Depends(verify_api_key), Depends(check_rate_limit)])
async def predict(payload: ImagePayload):
    """Classify a base64-encoded image as safe or nsfw."""
    if ort_session is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    try:
        # Decode image
        image_bytes = base64.b64decode(payload.image_base64)
        image = Image.open(BytesIO(image_bytes)).convert("RGB")

        # Downscale large images before preprocessing to save memory
        max_dim = 1024
        if max(image.size) > max_dim:
            image.thumbnail((max_dim, max_dim), Image.LANCZOS)

        # Preprocess and run inference
        input_data = preprocess_image(image)
        outputs = ort_session.run(None, {input_name: input_data})

        # Sigmoid output -> probability
        score = float(outputs[0][0][0])
        status = "nsfw" if score > NSFW_THRESHOLD else "safe"

        return {"status": status, "confidence": round(score, 4)}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Prediction failed: {e}")
        raise HTTPException(status_code=400, detail="Failed to process image")